-- VibeSafe Builder — complete database schema.
--
-- Until now this lived only in the Supabase dashboard, which made a test
-- environment impossible to stand up reproducibly: there was nothing to apply.
-- This file is introspected from the live production database, so it is a
-- faithful record rather than a guess, and is what provisions any new
-- environment (test, staging, a fresh production).
--
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql
-- or paste into the Supabase SQL editor of a fresh project.
--
-- RLS CONVENTION USED HERE
-- Tables the server reaches only through the service-role client have RLS
-- enabled and NO policies at all. Service-role bypasses RLS by design, so this
-- makes them completely unreachable with the public anon key that ships to every
-- browser via /api/config. That is the security boundary for all of the
-- app-backend tables below, and it is asserted by the integration tests.

/* ============================ billing / accounts ============================ */

-- Managed-plan subscription state, mirrored from Stripe webhooks.
create table if not exists subscriptions (
  user_id                uuid primary key references auth.users(id),
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 text not null default 'inactive',
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table subscriptions enable row level security;
-- Signed-in users may read their own row; all writes are server-side only.
drop policy if exists "read own subscription" on subscriptions;
create policy "read own subscription" on subscriptions
  for select using (auth.uid() = user_id);

-- Per-user, per-month AI spend against the managed plan's budget.
create table if not exists managed_usage (
  user_id       uuid not null references auth.users(id),
  period        text not null,              -- 'YYYY-MM'
  dollars_spent numeric not null default 0, -- every attempt, success or not
  build_count   integer not null default 0, -- successes only
  updated_at    timestamptz not null default now(),
  primary key (user_id, period)
);
alter table managed_usage enable row level security;
drop policy if exists "read own usage" on managed_usage;
create policy "read own usage" on managed_usage
  for select using (auth.uid() = user_id);

/* ============================ published apps ============================ */

-- One row per published app; `html` is served verbatim at GET /p/:id.
create table if not exists published_apps (
  id         text primary key,
  html       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table published_apps enable row level security;

-- !! KNOWN ISSUE — see docs/security-notes.md !!
-- These policies allow ANY holder of the public anon key to insert or update ANY
-- row, because /api/publish writes through the anon client. That means a third
-- party can overwrite someone else's published app. Recorded here as-is because
-- this file documents what production actually has; the fix (route publish
-- writes through the service-role client, then drop these policies) is tracked
-- separately rather than changed silently.
drop policy if exists "public read" on published_apps;
create policy "public read" on published_apps for select using (true);
drop policy if exists "public insert" on published_apps;
create policy "public insert" on published_apps for insert with check (true);
drop policy if exists "public update" on published_apps;
create policy "public update" on published_apps for update using (true);

-- Idempotency ledger so a retried publish returns the original result instead of
-- re-running. Keyed by a client-supplied UUID, not app_id, so deliberate
-- republishes still work normally.
create table if not exists publish_attempts (
  publish_key    text primary key,
  app_id         text not null,
  status         text not null,
  failure_stage  text,
  failure_reason text,
  created_at     timestamptz not null default now()
);
create index if not exists publish_attempts_app_idx on publish_attempts (app_id, created_at desc);
alter table publish_attempts enable row level security;
-- No policies: service-role only.

/* ==================== backend for generated apps (1a / 1b) ==================== */

-- Opaque per-app credential injected into the published HTML. Deliberately NOT a
-- column on published_apps, which is anon-readable (see policies above) and would
-- therefore expose it to a direct REST query.
create table if not exists app_backend_keys (
  app_id     text primary key references published_apps(id) on delete cascade,
  app_key    text not null,
  created_at timestamptz not null default now()
);
alter table app_backend_keys enable row level security;
-- No policies: service-role only. This is the boundary that keeps app keys out
-- of reach of the public anon key.

-- The generated app's OWN end users (e.g. parents signing up to a school app).
-- Entirely separate from VibeSafe Builder's auth.users; scoped per app so two
-- generated apps can each have a 'sarah'.
create table if not exists app_end_users (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null references published_apps(id) on delete cascade,
  username      text not null,
  password_salt text not null,  -- base64, 16 random bytes
  password_hash text not null,  -- base64, scrypt(password, salt, 64)
  created_at    timestamptz not null default now(),
  unique (app_id, username)
);
alter table app_end_users enable row level security;
-- No policies: service-role only. Password material must never be anon-readable.

-- Generic JSON record store, scoped per app.
--   owner_id null + is_shared true  = Phase 1a behaviour (shared, unowned)
--   owner_id set + is_shared false  = private to that end user
--   owner_id set + is_shared true   = public but still owned (only owner edits)
create table if not exists app_records (
  id         uuid primary key default gen_random_uuid(),
  app_id     text not null references published_apps(id) on delete cascade,
  collection text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_id   uuid references app_end_users(id) on delete cascade,
  is_shared  boolean not null default true
);
create index if not exists app_records_app_collection_created_idx
  on app_records (app_id, collection, created_at desc);
create index if not exists app_records_owner_idx  on app_records (app_id, owner_id);
create index if not exists app_records_shared_idx on app_records (app_id, collection, is_shared);
alter table app_records enable row level security;
-- No policies: service-role only.
