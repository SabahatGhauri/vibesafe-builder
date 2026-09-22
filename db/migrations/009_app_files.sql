-- 009: files uploaded by the people who USE a generated app.
--
-- The bucket is private. Files are served back through /api/backend/files/:id
-- rather than from a storage URL, because published apps run under a CSP that
-- only allows images from their own origin - a storage URL would not render,
-- and widening the policy for every app in order to serve a few files is the
-- wrong trade.
--
-- Safe to re-run.

insert into storage.buckets (id, name, public)
  values ('app-files', 'app-files', false)
  on conflict (id) do nothing;

create table if not exists public.app_files (
  id         uuid primary key,
  app_id     text not null references published_apps(id) on delete cascade,
  owner_id   text,                       -- the app's own end user, when signed in
  name       text not null,
  mime       text not null check (mime in ('image/png','image/jpeg','image/gif','image/webp','application/pdf')),
  bytes      integer not null check (bytes > 0 and bytes <= 2097152),
  path       text not null,
  created_at timestamptz not null default now()
);
create index if not exists app_files_app_idx on public.app_files (app_id, created_at desc);

alter table public.app_files enable row level security;
-- No policies: the server (service_role) is the only reader and writer, the
-- same convention as app_records. An end user reaches a file through the API,
-- never through the database.
revoke all on public.app_files from anon, authenticated;
grant all on public.app_files to service_role;

-- The mime check above is the database's own opinion, not a restatement of the
-- application's: lib/appFiles.js decides a file's type by inspecting its bytes,
-- and this constraint means a bug there still cannot store something that was
-- never on the list.
