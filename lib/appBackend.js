// Backend-for-generated-apps: a per-published-app JSON data store plus optional
// per-app end-user accounts, so a single-file generated app can persist data
// shared across devices/visitors (a guestbook, a leaderboard) AND keep data
// private per signed-in visitor (a booking app where parents only see their own
// children) — without any multi-file rewrite of the generator itself.
//
// Two layers, both live:
//   Phase 1a — app-scoped records. Caller proves "I am app X" with app_id/app_key.
//   Phase 1b — end-user accounts scoped to one app. A visitor signs up/logs in
//              INSIDE the generated app; records they create are private to them
//              unless explicitly marked shared.
//
// The generated app's end-users are entirely separate from VibeSafe Builder's own
// Supabase Auth pool — two different generated apps can each have a "sarah", and
// neither has anything to do with the builder account that created the app.
//
// SECURITY MODEL — what a generated app actually receives:
// A generated app gets ONLY an opaque per-app token (app_key: 24 random bytes),
// never the Supabase service-role key, never the anon key, never any database
// credential. That token proves exactly one thing — "I am app X" — and every query
// below is hard-scoped .eq("app_id", ...) on the server, so it grants nothing
// beyond that one app's own rows. It is not secret in the traditional sense (it
// ships in the published page source, visible via view-source), which is precisely
// why it must not be, and is not, capable of anything but identifying the app.
// Real per-visitor privacy comes from the end-user token, not the app_key.
// app_records / app_backend_keys / app_end_users all have RLS enabled with NO
// policies, so even the public anon key shipped to every browser via /api/config
// cannot read them directly — all access is mediated by this module's routes
// using the service-role client, which never leaves the server.

const crypto = require("crypto");

const MAX_RECORDS_PER_APP = 1000;
const MAX_RECORD_BYTES = 8 * 1024; // 8KB
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const USERNAME_RE = /^[a-zA-Z0-9._@+-]{1,64}$/;
const MIN_PASSWORD_LEN = 8;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Signing key for end-user tokens. Prefers an explicit secret, but derives a
// domain-separated one from the service-role key when unset so the feature works
// without extra deployment config. Consequence worth knowing: rotating the
// service-role key invalidates outstanding end-user tokens (everyone simply logs
// in again) — set APP_BACKEND_TOKEN_SECRET explicitly to decouple the two.
function tokenSecret() {
  const explicit = process.env.APP_BACKEND_TOKEN_SECRET;
  if (explicit) return Buffer.from(explicit, "utf8");
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return crypto.createHash("sha256").update("vibesafe-app-backend-tokens|" + base).digest();
}

// scrypt is deliberately slow (~50-100ms at these parameters), which is also the
// only brute-force protection on login right now — there's no rate limiter here yet
// (serverless makes in-memory counters unreliable across instances). Documented
// limitation, not an oversight.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

function verifyPassword(password, saltB64, hashB64) {
  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length);
    // timingSafeEqual throws on length mismatch rather than returning false.
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Minimal signed token instead of pulling in a JWT library: a single fixed
// algorithm with no caller-supplied "alg" field, so the classic JWT algorithm-
// confusion attack has no surface here at all.
function signToken({ userId, appId }) {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, appId, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token, appId) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.exp < Date.now()) return null;
  // A token minted for app A must never authenticate against app B, even though
  // both are signed with the same server secret.
  if (claims.appId !== appId) return null;
  return { userId: claims.sub };
}

// Get-or-create semantics, so a retried/duplicated publish can never mint a second
// credential for the same app: app_id is the PRIMARY KEY, and this upserts with
// ignoreDuplicates then reads back whatever is actually stored. A republish always
// returns the app's existing key rather than rotating it out from under data the
// app is already collecting.
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
  const tag =
    "<script>window.VIBESAFE_APP_ID=" +
    JSON.stringify(appId) +
    ";window.VIBESAFE_APP_KEY=" +
    JSON.stringify(appKey) +
    ';window.VIBESAFE_BACKEND_URL="/api/backend";</script>';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + "\n" + tag);
  }
  return tag + html;
}

function shape(row) {
  return {
    id: row.id,
    collection: row.collection,
    data: row.data,
    createdAt: row.created_at,
    ownerId: row.owner_id || null,
    shared: row.is_shared,
  };
}

const ROW_COLS = "id, collection, data, created_at, owner_id, is_shared";

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
    res.set("Access-Control-Allow-Headers", "x-app-id, x-app-key, authorization, content-type");
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
    const { data, error } = await supabaseAdmin
      .from("app_backend_keys")
      .select("app_key")
      .eq("app_id", appId)
      .maybeSingle();
    if (error || !data || data.app_key !== appKey) return res.status(401).json({ error: "Invalid app credentials." });
    req.vibesafeAppId = appId;
    // Optional end-user identity layered on top. Absent/invalid simply means
    // "anonymous visitor of this app" — never an error, since plenty of apps
    // (guestbooks, leaderboards) are meant to work without anyone logging in.
    const auth = req.header("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const claims = bearer ? verifyToken(bearer, appId) : null;
    req.endUserId = claims ? claims.userId : null;
    next();
  }

  router.use(requireAppAuth);

  /* ---------------- end-user accounts (Phase 1b) ---------------- */

  router.post("/auth/signup", async (req, res) => {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || "")) return res.status(400).json({ error: "Invalid username." });
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: "Password must be at least " + MIN_PASSWORD_LEN + " characters." });
    }
    const { salt, hash } = hashPassword(password);
    const { data, error } = await supabaseAdmin
      .from("app_end_users")
      .insert({ app_id: req.vibesafeAppId, username, password_salt: salt, password_hash: hash })
      .select("id, username, created_at")
      .single();
    // 23505 = unique_violation on (app_id, username).
    if (error && error.code === "23505") return res.status(409).json({ error: "That username is already taken." });
    if (error) return res.status(500).json({ error: "Could not create account: " + error.message });
    res.status(201).json({
      token: signToken({ userId: data.id, appId: req.vibesafeAppId }),
      user: { id: data.id, username: data.username },
    });
  });

  router.post("/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password are required." });
    }
    const { data, error } = await supabaseAdmin
      .from("app_end_users")
      .select("id, username, password_salt, password_hash")
      .eq("app_id", req.vibesafeAppId)
      .eq("username", username)
      .maybeSingle();
    // Same response whether the user doesn't exist or the password is wrong —
    // otherwise this endpoint doubles as a username enumeration oracle.
    if (error || !data || !verifyPassword(password, data.password_salt, data.password_hash)) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    res.json({
      token: signToken({ userId: data.id, appId: req.vibesafeAppId }),
      user: { id: data.id, username: data.username },
    });
  });

  router.get("/auth/me", async (req, res) => {
    if (!req.endUserId) return res.status(401).json({ error: "Not signed in." });
    const { data, error } = await supabaseAdmin
      .from("app_end_users")
      .select("id, username, created_at")
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.endUserId)
      .maybeSingle();
    if (error || !data) return res.status(401).json({ error: "Not signed in." });
    res.json({ user: { id: data.id, username: data.username, createdAt: data.created_at } });
  });

  /* ---------------- records ---------------- */

  // Visibility rules, applied uniformly below:
  //   read  — is_shared = true (anyone) OR owner_id = the signed-in end-user
  //   write — owner_id IS NULL (unowned, 1a-style) OR owner_id = the signed-in end-user
  // Anonymous creates are unowned+shared, which is exactly Phase 1a's behaviour, so
  // every record written before this layer existed keeps working unchanged.
  function canRead(row, endUserId) {
    return row.is_shared || (endUserId && row.owner_id === endUserId);
  }
  function canWrite(row, endUserId) {
    return row.owner_id === null || (endUserId && row.owner_id === endUserId);
  }

  router.post("/records", async (req, res) => {
    const { collection, data, shared } = req.body || {};
    if (!COLLECTION_RE.test(collection || "")) return res.status(400).json({ error: "Invalid collection name." });
    if (data === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
      return res.status(400).json({ error: "`data` must be a JSON object." });
    }
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES) {
      return res.status(413).json({ error: "Record too large — max " + MAX_RECORD_BYTES + " bytes." });
    }
    const { count, error: countError } = await supabaseAdmin
      .from("app_records")
      .select("id", { count: "exact", head: true })
      .eq("app_id", req.vibesafeAppId);
    if (countError) return res.status(500).json({ error: "Could not check quota: " + countError.message });
    if ((count || 0) >= MAX_RECORDS_PER_APP) {
      return res.status(403).json({ error: "This app has reached its " + MAX_RECORDS_PER_APP + "-record limit." });
    }
    // Signed in: private by default, opt into sharing. Anonymous: always shared,
    // since there'd be no owner who could ever read it back otherwise.
    const isShared = req.endUserId ? shared === true : true;
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .insert({
        app_id: req.vibesafeAppId,
        collection,
        data,
        owner_id: req.endUserId,
        is_shared: isShared,
      })
      .select(ROW_COLS)
      .single();
    if (error) return res.status(500).json({ error: "Could not create record: " + error.message });
    res.status(201).json(shape(row));
  });

  router.get("/records", async (req, res) => {
    const collection = req.query.collection;
    if (!COLLECTION_RE.test(collection || "")) return res.status(400).json({ error: "Invalid collection name." });
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIST_LIMIT));
    let q = supabaseAdmin
      .from("app_records")
      .select(ROW_COLS)
      .eq("app_id", req.vibesafeAppId)
      .eq("collection", collection)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (req.query.before) q = q.lt("created_at", req.query.before);
    if (req.query.mine === "true") {
      if (!req.endUserId) return res.status(401).json({ error: "Sign in to list your own records." });
      q = q.eq("owner_id", req.endUserId);
    } else if (req.endUserId) {
      q = q.or("is_shared.eq.true,owner_id.eq." + req.endUserId);
    } else {
      q = q.eq("is_shared", true);
    }
    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: "Could not list records: " + error.message });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({ records: page.map(shape), hasMore });
  });

  // Fetch-then-check rather than folding the visibility rule into the query: one
  // extra round trip, but the authorization decision is explicit and readable
  // instead of hidden in query-builder chaining. Worth it on a security boundary.
  async function loadOwn(req, id) {
    const { data, error } = await supabaseAdmin
      .from("app_records")
      .select(ROW_COLS)
      .eq("app_id", req.vibesafeAppId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  router.get("/records/:id", async (req, res) => {
    let row;
    try {
      row = await loadOwn(req, req.params.id);
    } catch (err) {
      return res.status(500).json({ error: "Could not load record: " + err.message });
    }
    // 404 rather than 403 for a record that exists but isn't visible — a 403 would
    // confirm the id is real, which is itself a leak.
    if (!row || !canRead(row, req.endUserId)) return res.status(404).json({ error: "Not found." });
    res.json(shape(row));
  });

  router.put("/records/:id", async (req, res) => {
    const { data } = req.body || {};
    if (data === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
      return res.status(400).json({ error: "`data` must be a JSON object." });
    }
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES) {
      return res.status(413).json({ error: "Record too large — max " + MAX_RECORD_BYTES + " bytes." });
    }
    let existing;
    try {
      existing = await loadOwn(req, req.params.id);
    } catch (err) {
      return res.status(500).json({ error: "Could not update record: " + err.message });
    }
    if (!existing || !canRead(existing, req.endUserId)) return res.status(404).json({ error: "Not found." });
    if (!canWrite(existing, req.endUserId)) {
      return res.status(403).json({ error: "That record belongs to someone else." });
    }
    const { data: row, error } = await supabaseAdmin
      .from("app_records")
      .update({ data, updated_at: new Date().toISOString() })
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.params.id)
      .select(ROW_COLS)
      .maybeSingle();
    if (error) return res.status(500).json({ error: "Could not update record: " + error.message });
    if (!row) return res.status(404).json({ error: "Not found." });
    res.json(shape(row));
  });

  router.delete("/records/:id", async (req, res) => {
    let existing;
    try {
      existing = await loadOwn(req, req.params.id);
    } catch (err) {
      return res.status(500).json({ error: "Could not delete record: " + err.message });
    }
    if (!existing || !canRead(existing, req.endUserId)) return res.status(404).json({ error: "Not found." });
    if (!canWrite(existing, req.endUserId)) {
      return res.status(403).json({ error: "That record belongs to someone else." });
    }
    const { error } = await supabaseAdmin
      .from("app_records")
      .delete()
      .eq("app_id", req.vibesafeAppId)
      .eq("id", req.params.id);
    if (error) return res.status(500).json({ error: "Could not delete record: " + error.message });
    res.json({ deleted: true });
  });

  app.use("/api/backend", router);
}

module.exports = {
  provisionAppKey,
  injectBackendConfig,
  registerAppBackendRoutes,
  // Exported for offline unit tests (no credentials required).
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
};
