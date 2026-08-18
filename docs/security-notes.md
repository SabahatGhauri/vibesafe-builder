# Security notes

## OPEN — anyone with the public anon key can overwrite any published app

**Found:** 2026-08-18, while introspecting the live schema into `db/schema.sql`.
**Status:** not fixed. Recorded rather than changed silently, because the fix
touches the publish path and needs a deliberate decision.

### What it is

`published_apps` has these policies in production:

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

### Why it wasn't just fixed

Changing it alters the publish path, which is the single most load-bearing
route in the product and currently has no integration coverage (see
`test/integration.test.js` — the layer is written but has no environment to run
against yet). Fixing this against production with no test environment is exactly
the pattern being moved away from. Sequence should be: stand up the test
environment → run the integration suite → make this change → re-run → deploy.
