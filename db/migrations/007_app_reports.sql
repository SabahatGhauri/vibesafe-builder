-- 007: abuse reports and takedown for published apps.
--
-- Why: published apps are served from our own domain, so their content is our
-- exposure. Until now there was no way for a visitor to report an app and no
-- way for the owner to take one down short of editing the database by hand.
--
-- Safe to re-run. Existing published apps are unaffected: disabled_at is null,
-- which means "live", exactly as before.

alter table published_apps add column if not exists disabled_at timestamptz;
alter table published_apps add column if not exists disabled_reason text;

create table if not exists public.app_reports (
  id          uuid primary key default gen_random_uuid(),
  app_id      text not null,
  reason      text not null check (reason in ('illegal', 'sexual', 'violence', 'malware', 'impersonation', 'spam', 'other')),
  details     text,
  reporter    text,                       -- optional: only what the reporter chose to give
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists app_reports_open_idx on public.app_reports (created_at desc) where handled_at is null;
create index if not exists app_reports_app_idx on public.app_reports (app_id);

alter table public.app_reports enable row level security;
-- No policies: the server (service_role) is the only reader and writer, same
-- convention as every other table here. A report is written by an anonymous
-- visitor through an authenticated server route, never directly.
revoke all on public.app_reports from anon, authenticated;
grant all on public.app_reports to service_role;

-- Reporting is public, so it needs a bound that does not depend on a session.
-- Ten reports per app per hour is enough for a real problem to be noticed and
-- low enough that one person cannot fill the table.
create or replace function public.file_app_report(p_app text, p_reason text, p_details text, p_reporter text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('app-reports:' || p_app, 0));
  if (select count(*) from app_reports where app_id = p_app and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'report_rate_limit';
  end if;
  insert into app_reports (app_id, reason, details, reporter)
    values (p_app, p_reason, left(coalesce(p_details, ''), 2000), left(coalesce(p_reporter, ''), 254))
    returning id into new_id;
  return new_id;
end $$;

revoke all on function public.file_app_report(text, text, text, text) from public, anon, authenticated;
grant execute on function public.file_app_report(text, text, text, text) to service_role;
