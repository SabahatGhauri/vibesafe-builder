-- Native forms: all reads/writes pass through authenticated server routes.
create table if not exists public.native_forms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  kind text not null check (kind in ('contact', 'waitlist')),
  notification_email text not null,
  notify boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists native_forms_owner_idx on public.native_forms(owner_id);
alter table public.native_forms enable row level security;
revoke all on public.native_forms from anon, authenticated;
grant all on public.native_forms to service_role;

create table if not exists public.native_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.native_forms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null,
  notification_status text not null default 'disabled'
    check (notification_status in ('disabled','pending','sent','failed')),
  created_at timestamptz not null default now()
);
create index if not exists native_submissions_form_idx on public.native_form_submissions(form_id, created_at desc);
create index if not exists native_submissions_owner_idx on public.native_form_submissions(owner_id, created_at desc);
alter table public.native_form_submissions enable row level security;
revoke all on public.native_form_submissions from anon, authenticated;
grant all on public.native_form_submissions to service_role;

-- Bound creation across concurrent server instances.
create or replace function public.create_native_form(p_owner uuid, p_name text, p_kind text, p_email text, p_notify boolean)
returns public.native_forms language plpgsql security definer set search_path = public as $$
declare result public.native_forms;
begin
  perform pg_advisory_xact_lock(hashtextextended('native-forms:' || p_owner::text, 0));
  if (select count(*) from native_forms where owner_id = p_owner) >= 20 then
    raise exception 'form_limit';
  end if;
  insert into native_forms(owner_id, name, kind, notification_email, notify)
    values(p_owner, p_name, p_kind, p_email, p_notify) returning * into result;
  return result;
end $$;

-- Limits are transactional, not in-memory counters that reset per request.
-- 300 submissions per owner/calendar month, 1,000 retained, 10 per form/minute.
create or replace function public.submit_native_form(p_form uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f public.native_forms; sid uuid;
begin
  select * into f from native_forms where id = p_form;
  if not found then raise exception 'form_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('native-forms:' || f.owner_id::text, 0));
  select * into f from native_forms where id = p_form for update;
  if not found or not f.enabled then raise exception 'form_unavailable'; end if;
  if jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 16000 then raise exception 'invalid_data'; end if;
  if (select count(*) from native_form_submissions where form_id = p_form and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate_limit';
  end if;
  if (select count(*) from native_form_submissions where owner_id = f.owner_id and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') >= 300
    or (select count(*) from native_form_submissions where owner_id = f.owner_id) >= 1000 then
    raise exception 'submission_limit';
  end if;
  insert into native_form_submissions(form_id, owner_id, data, notification_status)
    values(f.id, f.owner_id, p_data, case when f.notify then 'pending' else 'disabled' end) returning id into sid;
  return jsonb_build_object('id', sid, 'notify', f.notify, 'email', f.notification_email, 'name', f.name);
end $$;
revoke all on function public.create_native_form(uuid,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.submit_native_form(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.create_native_form(uuid,text,text,text,boolean) to service_role;
grant execute on function public.submit_native_form(uuid,jsonb) to service_role;
