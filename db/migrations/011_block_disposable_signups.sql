-- 011: refuse accounts on throwaway email domains, on every signup path.
--
-- /api/signup already checks lib/disposableEmail.js. But the public Supabase
-- endpoint (/auth/v1/signup, reachable with the anon key that ships to every
-- browser) skips our server entirely, and that is how the 2026-10-17 batch of
-- maxxspace.com / 1secmail.com accounts was made. A "before user created" auth
-- hook runs on every path - our admin calls, the public endpoint and Google
-- sign-in - so it is the one place a block cannot be walked around.
--
-- After running this, switch the hook on: Supabase Dashboard > Authentication
-- > Hooks > "Before User Created" > Postgres > public.hook_block_disposable_signup.
--
-- The seed must match DISPOSABLE_DOMAINS in lib/disposableEmail.js
-- (test/disposableEmail.test.js checks). Safe to re-run.

create table if not exists public.blocked_email_domains (
  domain     text primary key,
  created_at timestamptz not null default now()
);

alter table public.blocked_email_domains enable row level security;
revoke all on table public.blocked_email_domains from public, anon, authenticated;
grant all on table public.blocked_email_domains to service_role;
grant select on table public.blocked_email_domains to supabase_auth_admin;

-- The auth server reads the table as supabase_auth_admin, which RLS would
-- otherwise hide every row from.
drop policy if exists "auth reads blocked domains" on public.blocked_email_domains;
create policy "auth reads blocked domains" on public.blocked_email_domains
  for select to supabase_auth_admin using (true);

insert into public.blocked_email_domains (domain) values
  ('maxxspace.com'),
  ('1secmail.com'),
  ('1secmail.net'),
  ('1secmail.org'),
  ('esiix.com'),
  ('wwjmp.com'),
  ('xojxe.com'),
  ('yoggm.com'),
  ('itssvk.dev'),
  ('mailinator.com'),
  ('mailinator.net'),
  ('mailinator2.com'),
  ('guerrillamail.com'),
  ('guerrillamail.net'),
  ('guerrillamail.org'),
  ('guerrillamail.biz'),
  ('guerrillamailblock.com'),
  ('sharklasers.com'),
  ('grr.la'),
  ('pokemail.net'),
  ('spam4.me'),
  ('10minutemail.com'),
  ('10minutemail.net'),
  ('temp-mail.org'),
  ('temp-mail.io'),
  ('tempmail.com'),
  ('tempmail.net'),
  ('tempmailo.com'),
  ('tempmail.plus'),
  ('tempail.com'),
  ('tempr.email'),
  ('yopmail.com'),
  ('yopmail.net'),
  ('yopmail.fr'),
  ('trashmail.com'),
  ('trashmail.de'),
  ('throwawaymail.com'),
  ('getnada.com'),
  ('nada.email'),
  ('dispostable.com'),
  ('maildrop.cc'),
  ('mailnesia.com'),
  ('mohmal.com'),
  ('emailondeck.com'),
  ('fakeinbox.com'),
  ('mintemail.com'),
  ('mytemp.email'),
  ('moakt.com'),
  ('mail.tm'),
  ('mail.gw'),
  ('dropmail.me'),
  ('emltmp.com'),
  ('spymail.one'),
  ('minimail.gq'),
  ('burnermail.io'),
  ('inboxkitten.com'),
  ('tmail.ws'),
  ('tmpmail.org'),
  ('tmpmail.net'),
  ('byom.de'),
  ('discard.email'),
  ('mailcatch.com'),
  ('spambox.us'),
  ('33mail.com'),
  ('getairmail.com'),
  ('fexpost.com'),
  ('fextemp.com'),
  ('zeroe.ml'),
  ('cyclelove.cc'),
  ('dcctb.com'),
  ('wuuvo.com'),
  ('rteet.com'),
  ('ezztt.com'),
  ('vjuum.com'),
  ('laafd.com'),
  ('txcct.com')
on conflict (domain) do nothing;

-- Matches the domain and any subdomain of it, like the JS version.
create or replace function public.hook_block_disposable_signup(event jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_domain text := lower(trim(trailing '.' from split_part(coalesce(event->'user'->>'email', ''), '@', 2)));
begin
  if v_domain <> '' and exists (
    select 1 from public.blocked_email_domains b
     where v_domain = b.domain or v_domain like '%.' || b.domain
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 400,
      'message', 'Please sign up with a permanent email address.'));
  end if;
  return '{}'::jsonb;
end $$;

grant execute on function public.hook_block_disposable_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_block_disposable_signup(jsonb) from public, anon, authenticated;
