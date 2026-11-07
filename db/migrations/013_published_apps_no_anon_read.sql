-- 013: remove the anon key's read access to published_apps.
--
-- Run this AFTER the deploy that ships migration 012's code is live. That code
-- reads GET /p/:id through the service role. The code before it read through the
-- anon key, so running this first would take every published app offline until
-- the deploy. Safe to re-run.
--
-- No more public listing of every app
--    The "public read" policy let anyone with the anon key (served by
--    /api/config) list every published app and preview, including unlisted
--    previews and each app's injected backend key, straight from Supabase REST.
--    GET /p/:id now reads through the service role, by exact id only, so the
--    anon role needs no access at all.

drop policy if exists "public read" on public.published_apps;
revoke select, insert, update, delete on public.published_apps from anon, authenticated;
