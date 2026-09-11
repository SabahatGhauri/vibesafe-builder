-- 004: anonymous daily generation counts for the owner dashboard.
--
-- Why: bring-your-own-key users never create an account, so /admin could not see
-- them at all - the dashboard only knew about signed-in users. This records one
-- aggregate row per UTC day per plan mode, and nothing else: no user id, no IP,
-- no API key, no prompt. It cannot identify anyone, by construction.
--
-- Apply to the TEST project first, then production (Supabase SQL editor).
-- Safe to re-run.

create table if not exists generation_stats (
  day        date not null,
  mode       text not null check (mode in ('byok', 'managed')),
  builds     integer not null default 0,  -- generations that produced a usable app
  failures   integer not null default 0,  -- errored, refused or unusable generations
  cost       numeric not null default 0,  -- model cost in USD (for BYOK: the user's own Anthropic bill, from token counts)
  updated_at timestamptz not null default now(),
  primary key (day, mode)
);
alter table generation_stats enable row level security;
-- No policies: service-role only, per the RLS convention in db/schema.sql.

-- Atomic increment. supabase-js cannot express "col = col + 1" in an upsert, and a
-- read-then-write from the server would lose counts when two generations finish
-- in the same moment.
create or replace function record_generation_stat(p_mode text, p_cost numeric, p_succeeded boolean)
returns void
language sql
set search_path = public
as $$
  insert into generation_stats (day, mode, builds, failures, cost)
  values (
    (now() at time zone 'utc')::date,
    p_mode,
    case when p_succeeded then 1 else 0 end,
    case when p_succeeded then 0 else 1 end,
    greatest(coalesce(p_cost, 0), 0)
  )
  on conflict (day, mode) do update set
    builds     = generation_stats.builds + excluded.builds,
    failures   = generation_stats.failures + excluded.failures,
    cost       = generation_stats.cost + excluded.cost,
    updated_at = now();
$$;

-- Functions in public are callable over REST by default. The table's RLS already
-- stops anon/authenticated from writing through it (the function runs as the
-- caller), but there is no reason to leave it callable at all.
revoke execute on function record_generation_stat(text, numeric, boolean) from public, anon, authenticated;
grant execute on function record_generation_stat(text, numeric, boolean) to service_role;
