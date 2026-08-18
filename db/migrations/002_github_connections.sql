-- Phase 2D: GitHub repository sync.
--
-- One connection per VibeSafe user. Tokens are stored ENCRYPTED (AES-256-GCM,
-- see lib/github.js) rather than in plaintext: a `repo`-scoped GitHub token
-- grants write access to the user's repositories, so RLS alone — which only
-- stops the anon key reaching the row — isn't a sufficient story for it. The
-- encryption key never lives in the database, so a database dump on its own
-- does not yield usable tokens.
--
-- RLS is enabled with NO policies, matching every other server-only table here:
-- the public anon key cannot touch this at all, and access goes exclusively
-- through the service-role client in routes that verify the caller's session.

create table if not exists github_connections (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  github_id        bigint not null,
  github_login     text not null,
  access_token     text not null,   -- encrypted
  refresh_token    text,            -- encrypted; present when the OAuth app expires tokens
  token_expires_at timestamptz,
  scope            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table github_connections enable row level security;
-- No policies: service-role only.

-- Which repo a project is linked to, so push/pull don't have to be told every time.
create table if not exists github_repo_links (
  user_id     uuid not null references auth.users(id) on delete cascade,
  project_key text not null,          -- the builder's local project id
  owner       text not null,
  repo        text not null,
  branch      text not null default 'main',
  updated_at  timestamptz not null default now(),
  primary key (user_id, project_key)
);
alter table github_repo_links enable row level security;
-- No policies: service-role only.
