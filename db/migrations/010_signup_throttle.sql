-- 010: a throttle for account-confirmation emails.
--
-- Signup confirmation is moving off Supabase's own /auth/v1/signup endpoint and
-- onto admin.generateLink() + Resend, so that auth email stops depending on
-- Supabase's SMTP configuration (see lib/signup.js for the whole reasoning).
--
-- That swap quietly drops something, and this migration is what puts it back.
-- Supabase's public signup endpoint is rate limited by Supabase. The admin API
-- is not - it is meant to be called by trusted server code, so it assumes the
-- caller already decided this was reasonable. Without a limit here, anyone
-- could POST /api/signup in a loop and have us mail every address they like.
-- That is an open relay, and it is also exactly how a sender reputation gets
-- destroyed by bounces - the problem this whole change exists to fix.
--
-- Addresses are stored as md5(lower(email)), not in the clear. This table would
-- otherwise accumulate addresses belonging to people who never signed up, which
-- is PII we have no reason to hold. md5 is used as a bucketing key, not as a
-- security control: it needs to group repeat attempts, nothing more.
--
-- Safe to re-run.

create table if not exists public.signup_attempts (
  id         uuid primary key default gen_random_uuid(),
  email_key  text not null,
  ip_key     text,
  created_at timestamptz not null default now()
);

create index if not exists signup_attempts_email_idx on public.signup_attempts (email_key, created_at desc);
create index if not exists signup_attempts_ip_idx    on public.signup_attempts (ip_key, created_at desc);

-- The standing convention in this schema: RLS on, zero policies, and explicit
-- grants. service_role bypasses RLS by design; anon and authenticated get
-- nothing at all. Nobody holding the public anon key can read who tried to
-- sign up, or when.
alter table public.signup_attempts enable row level security;
revoke all on table public.signup_attempts from public, anon, authenticated;
grant all on table public.signup_attempts to service_role;

-- Returns true when we are willing to send a confirmation to this address right
-- now, and records the attempt when we are. Both limits matter and they catch
-- different things: the per-address one stops the same person being mailed over
-- and over, the per-IP one stops one caller working through a list.
--
-- The attempt is recorded for allowed requests only. A refused attempt that
-- counted toward the limit would let a caller hold an address in timeout
-- indefinitely by continuing to hammer it.
create or replace function public.may_send_signup_email(p_email text, p_ip text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_email_key text := md5(lower(trim(p_email)));
  v_ip_key    text := case when p_ip is null or trim(p_ip) = '' then null else md5(trim(p_ip)) end;
  v_per_email int;
  v_per_ip    int;
begin
  -- Serialise on the address so two simultaneous requests cannot both read a
  -- count of 2 and both decide they are the third.
  perform pg_advisory_xact_lock(hashtextextended('signup-email:' || v_email_key, 0));

  -- Nothing here is interesting after a day, and at this volume the tidy-up is
  -- cheaper than a scheduled job would be to maintain.
  delete from signup_attempts where created_at < now() - interval '1 day';

  select count(*) into v_per_email
    from signup_attempts
   where email_key = v_email_key
     and created_at > now() - interval '1 hour';
  if v_per_email >= 3 then return false; end if;

  if v_ip_key is not null then
    select count(*) into v_per_ip
      from signup_attempts
     where ip_key = v_ip_key
       and created_at > now() - interval '1 hour';
    if v_per_ip >= 10 then return false; end if;
  end if;

  insert into signup_attempts(email_key, ip_key) values (v_email_key, v_ip_key);
  return true;
end $$;

revoke all on function public.may_send_signup_email(text, text) from public, anon, authenticated;
grant execute on function public.may_send_signup_email(text, text) to service_role;
