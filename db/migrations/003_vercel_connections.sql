-- Phase 3A: deploying to the user's own Vercel account.
--
-- One Vercel connection per VibeSafe user. The access token is stored
-- ENCRYPTED (AES-256-GCM, see lib/secrets.js) with a key derived from a server
-- env var and domain-separated from the GitHub key, so a database dump yields
-- nothing usable and one integration's ciphertext cannot be read by another.
--
-- RLS is enabled with NO policies, matching every other server-only table here:
-- the public anon key cannot touch this at all, and access goes exclusively
-- through the service-role client in routes that verify the caller's session.

create table if not exists vercel_connections (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,   -- encrypted; never leaves the server
  token_hint   text not null,   -- e.g. vcp_••••1234, safe to show in the UI
  token_scope  text not null,   -- project | team | account, as detected at connect time
  project_id   text,            -- the Vercel project deployments go to
  project_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table vercel_connections enable row level security;
-- No policies: service-role only.

-- A durable record of every deployment and every security-relevant change made
-- on the user's behalf. Written by the server, never by the client, and kept
-- even when the connection is deleted (user_id is the only link, and the row
-- survives token rotation) — an audit trail that disappears when someone
-- disconnects would not be much of an audit trail.
--
-- Phase 3A writes 'deploy' events. Phase 3B adds 'protection_disabled' and
-- 'protection_enabled', which is the reason this is a general event log rather
-- than a deployments table.
create table if not exists deployment_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null,          -- vercel | vibesafe
  event       text not null,          -- deploy | protection_disabled | protection_enabled | disconnect
  project_id  text,
  project_name text,
  deployment_id text,
  url         text,
  environment text,                   -- preview | production
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists deployment_events_user_created_idx
  on deployment_events (user_id, created_at desc);
alter table deployment_events enable row level security;
-- No policies: service-role only.
