-- 012: who owns a published app, a per-account build lock, and atomic spend.
--
-- Run this in the Supabase SQL editor BEFORE deploying the code that ships with
-- it, and 013 AFTER that deploy is live. Safe to re-run.
--
-- 1. published_apps.owner_id
--    POST /api/publish used to accept any app id and overwrite that row, with no
--    check on the caller. Every id is in its public /p/<id> URL, so anyone could
--    replace anyone's live app. Writes now record the publishing account here,
--    and lib/publishAuth.js refuses a write to an id owned by someone else.
--    Rows published before this migration have owner_id null and are locked:
--    the builder publishes their next version to a new link. To hand an old app
--    to its maker once you've confirmed who that is:
--      update published_apps set owner_id = '<auth user id>' where id = '<app id>';

alter table public.published_apps
  add column if not exists owner_id uuid references auth.users(id) on delete set null;
create index if not exists published_apps_owner_idx on public.published_apps (owner_id);

-- 2. One platform-key build in flight per account (lib/usageGuard.js)

create table if not exists public.generation_locks (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  locked_at timestamptz not null default now()
);
alter table public.generation_locks enable row level security;
-- No policies: service-role only.

-- 3. Atomic spend recording
--    Replaces read-then-write, which lost spend when two builds finished at once.

create or replace function public.add_usage(p_user uuid, p_period text, p_amount numeric, p_build integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into managed_usage (user_id, period, dollars_spent, build_count, updated_at)
  values (p_user, p_period, greatest(p_amount, 0), greatest(p_build, 0), now())
  on conflict (user_id, period) do update
    set dollars_spent = managed_usage.dollars_spent + greatest(excluded.dollars_spent, 0),
        build_count   = managed_usage.build_count + greatest(excluded.build_count, 0),
        updated_at    = now();
$$;

revoke all on function public.add_usage(uuid, text, numeric, integer) from public, anon, authenticated;
grant execute on function public.add_usage(uuid, text, numeric, integer) to service_role;
