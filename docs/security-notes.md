# Security notes

## FIXED (2026-08-18) — anyone with the public anon key could overwrite any published app

**Found:** 2026-08-18, while introspecting the live schema into `db/schema.sql`.
**Status:** FIXED in commit `3a84207` + `db/migrations/001`. Verified closed in
production: an anon-key PATCH against a real published app now updates 0 rows and
an anon INSERT is rejected with `42501`, while `GET /p/:id` still serves normally
and publishing still works. Two regression tests in `test/integration.test.js`
guard it (they were written first and watched to FAIL against the old policies).

### What it is

`published_apps` had these policies:

```sql
create policy "public insert" on published_apps for insert with check (true);
create policy "public update" on published_apps for update using (true);
```

`for update using (true)` with no `with check` clause means **any** holder of the
anon key may update **any** row. The anon key is public by design — it is served
to every browser by `/api/config` — so this is effectively unauthenticated write
access to every published app's HTML.

These policies exist because `/api/publish` writes through the **anon** client
(`supabase`), not the service-role client (`supabaseAdmin`). Without them,
publishing would fail outright.

### Why it matters more than plain defacement

Published apps now carry an injected `window.VIBESAFE_APP_KEY` (Phase 1a). So the
chain is:

1. Attacker overwrites victim app `X`'s HTML with their own JavaScript.
2. On the next publish, or from the already-injected config in the page they
   just replaced, that JavaScript runs alongside app `X`'s own credentials.
3. Their code can then call `/api/backend/*` as app `X` — reading and deleting
   every shared record belonging to that app.

Per-user private records (Phase 1b) are **not** directly exposed, since those
additionally require an end-user bearer token. Shared records are.

### The fix

Route the two `published_apps` writes in `/api/publish` through `supabaseAdmin`
instead of `supabase`, then drop all three permissive policies (`public insert`,
`public update`, and `public read` can be narrowed to select-only, which is
genuinely needed since `GET /p/:id` reads through the anon client).

Roughly:

```js
// lib/app.js, POST /api/publish — both upserts
const db = supabaseAdmin || supabase;   // service-role when available
await db.from("published_apps").upsert({ ... });
```

```sql
drop policy "public insert" on published_apps;
drop policy "public update" on published_apps;
-- keep "public read": GET /p/:id serves published apps via the anon client
```

### Why it was not fixed the moment it was found

The fix alters the publish path — the single most load-bearing route in the
product — and at the time there was no integration coverage and no environment
to run it against. Patching production directly was exactly the pattern being
moved away from. The sequence actually followed was:

1. Stand up a dedicated test Supabase project (separate account, own credentials).
2. Apply `db/schema.sql` to it — which also proved the schema is reproducible.
3. Write the two regression tests and confirm they FAIL against the old policies.
4. Change the code, drop the policies in test, confirm 10/10 including that
   publishing still works.
5. Deploy the code to production, smoke-test it (32/32) while the old policies
   were still in place and harmless.
6. Only then drop the policies in production, and verify the hole is closed
   against a real published app.

Order mattered: dropping the policies before the code shipped would have broken
publishing for everyone in the gap.
