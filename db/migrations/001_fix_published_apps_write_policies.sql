-- Fixes the vulnerability in docs/security-notes.md.
--
-- published_apps carried:
--   create policy "public insert" ... with check (true);
--   create policy "public update" ... using (true);
-- Those existed because POST /api/publish wrote through the ANON client, and the
-- anon key is public — it is served to every browser by /api/config. So anyone
-- could overwrite anyone else's published app, and (since Phase 1a injects an
-- app key into every published page) then act as that app against /api/backend
-- and reach its shared records.
--
-- The code change lands first: lib/app.js now performs both published_apps
-- writes with supabaseAdmin (service-role), which bypasses RLS by design. Once
-- deployed, these two policies are dead weight AND a live hole, so they go.
--
-- "public read" is deliberately KEPT: GET /p/:id serves published apps through
-- the anon client, so public SELECT is required for the product to work.
--
-- ORDER MATTERS: deploy the code change before running this. If the policies are
-- dropped while the old anon-write code is still live, publishing breaks.

drop policy if exists "public insert" on published_apps;
drop policy if exists "public update" on published_apps;

-- Verify: should return exactly one row, "public read" / SELECT.
-- select policyname, cmd from pg_policies
--   where schemaname='public' and tablename='published_apps';
