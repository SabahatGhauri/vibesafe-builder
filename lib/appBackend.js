// Backend-for-generated-apps (Phase 1a): a generic, per-published-app JSON data
// store, so a single-file app can persist data shared across devices/visitors —
// a guestbook, a leaderboard, a shared list — without any multi-file rewrite of
// the generator itself. No per-user accounts yet (Phase 1b, not built): every
// record in a collection is visible to every caller who knows the app's own
// app_id/app_key, which is the correct model for "shared" data and deliberately
// NOT sufficient for anything the AI is told (see SYSTEM_PROMPT) to keep private.
//
// Security model: app_records/app_backend_keys have RLS enabled with NO
// policies, so the public anon key (shipped to every browser via /api/config)
// can never touch them directly — every access is mediated through the routes
// below, using the service-role client, with app_id scoping enforced in code
// (requireAppAuth sets req.vibesafeAppId; every query filters on it). The
// app_key only proves "which app_id" — it grants no access beyond that app's
// own records, even if leaked, since it's already visible in the published
// app's own page source anyway (not a secret in the traditional sense).

const crypto = require("crypto");

const MAX_RECORDS_PER_APP = 1000;
const MAX_RECORD_BYTES = 8 * 1024; // 8KB
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,40}$/;

// Idempotent — republishing the same app_id must never rotate its key out from
// under data it's already collecting, so this upserts-if-absent rather than
// always generating fresh.
async function provisionAppKey(supabaseAdmin, appId) {
  const candidate = crypto.randomBytes(24).toString("base64url");
  await supabaseAdmin
    .from("app_backend_keys")
    .upsert({ app_id: appId, app_key: candidate }, { onConflict: "app_id", ignoreDuplicates: true });
  const { data, error } = await supabaseAdmin.from("app_backend_keys").select("app_key").eq("app_id", appId).single();
  if (error) throw error;
  return data.app_key;
}

// Mirrors injectPWATags()'s <head> regex-replace pattern in lib/pwa.js — same
// "wrap the HTML at publish time" approach, just injecting different config.
function injectBackendConfig(html, { appId, appKey }) {
  const tag = `<script>window.VIBESAFE_APP_ID=${JSON.stringify(appId)};window.VIBESAFE_APP_KEY=${JSON.stringify(
    appKey
  )};window.VIBESAFE_BACKEND_URL="/api/backend";</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  }
  return tag + html;
}

function registerAppBackendRoutes(app, { supabaseAdmin }) {
  const express = require("express");
  const router = express.Router();

  // Scoped to this router only — everything else in the app stays same-origin-only
  // by design (see comment at ISOLATED_APPS_HOST in lib/app.js). Auth here is a
  // header token, not a cookie, so permissive CORS is the standard/correct choice
  // for a public data API (same approach Firebase/Supabase's own REST APIs take),
  // and it future-proofs for published apps eventually moving to their own origin.
  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "x-app-id, x-app-key, content-type");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  if (!supabaseAdmin) {
    router.use((req, res) => res.status(503).json({ error: "The app backend isn't configured on this server." }));
    app.use("/api/backend", router);
    return;
  }

  async function requireAppAuth(req, res, next) {
    const appId = req.header("x-app-id");
    const appKey = req.header("x-app-key");
    if (!appId || !appKey) return res.status(401).json({ error: "Missing x-app-id / x-app-key headers." });
    const { data, error } = await supabaseAdmin.from("app_backend_keys").select("app_key").eq("app_id", appId).maybeSingle();
    if (error || !data || data.app_key !== appKey) return res.status(401).json({ error: "Invalid app credentials." });
    req.vibesafeAppId = appId;
    next();
  }

  router.use(requireAppAuth);

  router.post("/records", async (req, res) => {
    const { collection, data } = req.body || {};
    if (!COLLECTION_RE.test(collection || "")) return res.status(400).json({ error: "Invalid collection name." });
    if (data === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
      return res.status(400).json({ error: "`data` must be a JSON object." });
    }
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES) {
      return res.status(413).json({ error: `Record too large — max ${MAX_RECORD_BYTES} bytes.` });
    }
    const { count, error: countError } = await supabaseAdmin
      .from("app_records")
      .select("id", { count: "exact", head: true })
      .eq("app_id", req.vibesafeAppId);
    if (countError) return res.status(500).json({ error: "Could not check quota: " + countError.message });
    if ((count || 0) >= MAX_RECORDS_PER_APP) {
      return res.status(403).json({ error: `This app has reached its ${MAX_RECORDS_PER_APP}-record limit.` });
    }
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .insert({ app_id: req.vibesafeAppId, collection, data })
      .select("id, collection, data, created_at")
      .single();
    if (error) return res.status(500).json({ error: "Could not create record: " + error.message });
    res.status(201).json({ id: row.id, collection: row.collection, data: row.data, createdAt: row.created_at });
  });

  router.get("/records", async (req, res) => {
    const collection = req.query.collection;
    if (!COLLECTION_RE.test(collection || "")) return res.status(400).json({ error: "Invalid collection name." });
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT));
    let q = supabaseAdmin
      .from("app_records")
      .select("id, collection, data, created_at")
      .eq("app_id", req.vibesafeAppId)
      .eq("collection", collection)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (req.query.before) q = q.lt("created_at", req.query.before);
    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: "Could not list records: " + error.message });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      records: page.map((r) => ({ id: r.id, collection: r.collection, data: r.data, createdAt: r.created_at })),
      hasMore,
    });
  });

  router.get("/records/:id", async (req, res) => {
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .select("id, collection, data, created_at")
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: "Could not load record: " + error.message });
    if (!row) return res.status(404).json({ error: "Not found." });
    res.json({ id: row.id, collection: row.collection, data: row.data, createdAt: row.created_at });
  });

  router.put("/records/:id", async (req, res) => {
    const { data } = req.body || {};
    if (data === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
      return res.status(400).json({ error: "`data` must be a JSON object." });
    }
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES) {
      return res.status(413).json({ error: `Record too large — max ${MAX_RECORD_BYTES} bytes.` });
    }
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .update({ data, updated_at: new Date().toISOString() })
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.params.id)
      .select("id, collection, data, created_at")
      .maybeSingle();
    if (error) return res.status(500).json({ error: "Could not update record: " + error.message });
    if (!row) return res.status(404).json({ error: "Not found." });
    res.json({ id: row.id, collection: row.collection, data: row.data, createdAt: row.created_at });
  });

  router.delete("/records/:id", async (req, res) => {
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .delete()
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.params.id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: "Could not delete record: " + error.message });
    if (!row) return res.status(404).json({ error: "Not found." });
    res.json({ deleted: true });
  });

  app.use("/api/backend", router);
}

module.exports = { provisionAppKey, injectBackendConfig, registerAppBackendRoutes };
