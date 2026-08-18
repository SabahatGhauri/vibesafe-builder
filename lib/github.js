// Phase 2D — GitHub repository sync.
//
// Lets a user connect their GitHub account, create a repo, push the project into
// it as a real commit, pull changes back, and browse history and branches. The
// point is that a project built here isn't trapped here — it's ordinary code in
// an ordinary repository the user owns.
//
// SECURITY POSTURE
// A `repo`-scoped token can write to every repository the user owns, so it gets
// treated as a real secret rather than a session detail:
//   * stored AES-256-GCM encrypted, with the key derived from a server env var —
//     a database dump alone yields nothing usable;
//   * the OAuth app issues expiring tokens, refreshed transparently here;
//   * the OAuth `state` is HMAC-signed and carries the user id, so a callback
//     can't be replayed or pointed at a different account;
//   * every route re-verifies the caller's Supabase session before touching a
//     token — being able to reach the endpoint is never sufficient.
//
// This is deliberately a separate OAuth app from the "Sign in with GitHub"
// provider: sign-in needs `user:email`, and forcing every login through a `repo`
// consent screen would over-permission users who just want an account.

const crypto = require("crypto");

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SITE_URL = process.env.SITE_URL || "https://vibesafebuilder.com";
const API = "https://api.github.com";
const STATE_TTL_MS = 10 * 60 * 1000; // an OAuth round trip is seconds; 10 min is generous

function isConfigured() {
  return Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

/* ---------------- secrets at rest ---------------- */

// Domain-separated so this key can never collide with the app-backend token key
// derived from the same source. Prefers an explicit secret; falls back to the
// service-role key so the feature works without extra deployment config, at the
// cost of tokens becoming undecryptable if that key is rotated (users reconnect).
function encryptionKey() {
  const base = process.env.GITHUB_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return crypto.createHash("sha256").update("vibesafe-github-tokens|" + base).digest();
}

function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const [ivB, tagB, ctB] = String(payload).split(".");
    if (!ivB || !tagB || !ctB) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampering, or corruption — all mean "no usable token".
    return null;
  }
}

/* ---------------- OAuth state ---------------- */

function signState(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + STATE_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyState(state) {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || claims.exp < Date.now()) return null;
    return claims.uid;
  } catch {
    return null;
  }
}

function authorizeUrl(userId) {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: SITE_URL + "/api/github/callback",
    // `repo` is the narrowest scope GitHub offers that can write code. It covers
    // private repos too — GitHub has no "public repos only, write" scope.
    scope: "repo read:user",
    state: signState(userId),
  });
  return "https://github.com/login/oauth/authorize?" + params.toString();
}

/* ---------------- token exchange ---------------- */

async function postToken(body) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || "GitHub rejected the token request");
  }
  return data;
}

function exchangeCode(code) {
  return postToken({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: SITE_URL + "/api/github/callback",
  });
}

function refreshAccessToken(refreshToken) {
  return postToken({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/* ---------------- GitHub API ---------------- */

async function gh(token, path, { method = "GET", body = null } = {}) {
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "VibeSafe-Builder",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || "GitHub API error " + r.status;
    const err = new Error(msg);
    err.status = r.status;
    err.details = data && data.errors;
    throw err;
  }
  return data;
}

const getViewer = (token) => gh(token, "/user");

const listRepos = (token) =>
  gh(token, "/user/repos?per_page=100&sort=updated&affiliation=owner").then((rs) =>
    (rs || []).map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private, defaultBranch: r.default_branch }))
  );

// auto_init gives the repo an initial commit, which means there is always a ref
// to build the first push on top of — otherwise the very first push has to take
// a completely different code path.
const createRepo = (token, { name, description, private: isPrivate = true }) =>
  gh(token, "/user/repos", {
    method: "POST",
    body: { name, description: description || "Built with VibeSafe Builder", private: isPrivate, auto_init: true },
  }).then((r) => ({ owner: r.owner.login, repo: r.name, private: r.private, defaultBranch: r.default_branch, url: r.html_url }));

const listBranches = (token, { owner, repo }) =>
  gh(token, `/repos/${owner}/${repo}/branches?per_page=100`).then((bs) =>
    (bs || []).map((b) => ({ name: b.name, sha: b.commit.sha }))
  );

const listCommits = (token, { owner, repo, branch = "main", limit = 20 }) =>
  gh(token, `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`).then((cs) =>
    (cs || []).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: (c.commit.author && c.commit.author.name) || (c.author && c.author.login) || "unknown",
      date: c.commit.author && c.commit.author.date,
      url: c.html_url,
    }))
  );

async function createBranch(token, { owner, repo, from = "main", name }) {
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
  await gh(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: { ref: "refs/heads/" + name, sha: ref.object.sha },
  });
  return { name, from };
}

// Pushes the whole project as ONE commit via the Git Data API: blobs -> tree ->
// commit -> move the ref. The Contents API would be one HTTP call per file and
// one commit per file, which would turn a 12-file project into 12 commits.
async function pushFiles(token, { owner, repo, branch = "main", files, message }) {
  const paths = Object.keys(files);
  if (!paths.length) throw new Error("Nothing to push — the project has no files.");

  let baseSha = null;
  let baseTree = null;
  try {
    const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    baseSha = ref.object.sha;
    const commit = await gh(token, `/repos/${owner}/${repo}/git/commits/${baseSha}`);
    baseTree = commit.tree.sha;
  } catch (err) {
    // 409 = empty repository, 404 = branch doesn't exist yet. Both mean this is
    // the first commit on this branch, which is legitimate, not a failure.
    if (err.status !== 404 && err.status !== 409) throw err;
  }

  const blobs = await Promise.all(
    paths.map(async (p) => {
      const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: { content: Buffer.from(files[p], "utf8").toString("base64"), encoding: "base64" },
      });
      return { path: p, mode: "100644", type: "blob", sha: blob.sha };
    })
  );

  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: baseTree ? { base_tree: baseTree, tree: blobs } : { tree: blobs },
  });

  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: {
      message: message || "Update from VibeSafe Builder",
      tree: tree.sha,
      parents: baseSha ? [baseSha] : [],
    },
  });

  if (baseSha) {
    await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: { sha: commit.sha },
    });
  } else {
    await gh(token, `/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: "refs/heads/" + branch, sha: commit.sha },
    });
  }

  return { sha: commit.sha, files: paths.length, url: commit.html_url || null };
}

// Only source-ish files are pulled back: a repo may contain images, lockfiles or
// binaries that the in-browser project model has no representation for.
const PULLABLE = /\.(jsx?|css|html|json|md|txt)$/i;
const MAX_PULL_BYTES = 100 * 1024;

async function pullFiles(token, { owner, repo, branch = "main" }) {
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);

  const wanted = (tree.tree || []).filter(
    (n) => n.type === "blob" && PULLABLE.test(n.path) && (n.size || 0) <= MAX_PULL_BYTES
  );
  const skipped = (tree.tree || []).filter((n) => n.type === "blob" && !wanted.includes(n)).map((n) => n.path);

  const files = {};
  await Promise.all(
    wanted.map(async (n) => {
      const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs/${n.sha}`);
      files[n.path] = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    })
  );
  return { files, sha: ref.object.sha, skipped };
}

module.exports = {
  isConfigured,
  encrypt,
  decrypt,
  signState,
  verifyState,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  gh,
  getViewer,
  listRepos,
  createRepo,
  listBranches,
  listCommits,
  createBranch,
  pushFiles,
  pullFiles,
};
