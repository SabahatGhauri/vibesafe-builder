// Phase 2D — HTTP surface for GitHub sync. Kept separate from lib/github.js so
// the GitHub client stays a pure, testable library and this file holds only
// request handling, session checks and persistence.

const gh = require("./github");

function registerGithubRoutes(app, { supabaseAdmin, getManagedUser, siteUrl }) {
  const SITE = siteUrl || process.env.SITE_URL || "https://vibesafebuilder.com";

  // Every route below re-verifies the caller's Supabase session. Reaching the
  // endpoint is never enough — the token being operated on belongs to whoever
  // that session says they are, not to whoever made the request.
  async function requireUser(req, res) {
    const user = await getManagedUser(req);
    if (!user) {
      res.status(401).json({ error: "Sign in first." });
      return null;
    }
    return user;
  }

  function guard(res) {
    if (!gh.isConfigured() || !supabaseAdmin) {
      res.status(503).json({ error: "GitHub sync isn't configured on this server." });
      return false;
    }
    return true;
  }

  // Loads the stored connection and hands back a USABLE access token, refreshing
  // it first if it has expired. Callers never see the storage details.
  async function tokenFor(userId) {
    const { data, error } = await supabaseAdmin
      .from("github_connections")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;

    const expired = data.token_expires_at && new Date(data.token_expires_at).getTime() < Date.now() + 60_000;
    if (!expired) {
      const token = gh.decrypt(data.access_token);
      return token ? { token, connection: data } : null;
    }

    const refresh = gh.decrypt(data.refresh_token);
    if (!refresh) return null; // non-expiring app, or unrecoverable — force a reconnect
    try {
      const fresh = await gh.refreshAccessToken(refresh);
      const updated = {
        access_token: gh.encrypt(fresh.access_token),
        refresh_token: gh.encrypt(fresh.refresh_token || refresh),
        token_expires_at: fresh.expires_in ? new Date(Date.now() + fresh.expires_in * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      await supabaseAdmin.from("github_connections").update(updated).eq("user_id", userId);
      return { token: fresh.access_token, connection: { ...data, ...updated } };
    } catch (err) {
      console.error("GitHub token refresh failed for", userId, err.message);
      return null;
    }
  }

  // Turns a thrown GitHub error into something a person can act on.
  function fail(res, err) {
    const status = err.status === 401 || err.status === 403 ? 403 : 400;
    const msg =
      err.status === 401
        ? "GitHub rejected the connection — reconnect your account."
        : err.status === 403
        ? "GitHub denied that action. The connection may not have permission for this repository."
        : err.message || "GitHub request failed";
    res.status(status).json({ error: msg });
  }

  /* ---------------- connect / disconnect ---------------- */

  // Returns the authorize URL rather than redirecting, because the caller has to
  // send its session header — which a plain browser navigation cannot do.
  app.post("/api/github/connect", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    res.json({ url: gh.authorizeUrl(user.id) });
  });

  // GitHub redirects the BROWSER here, so there is no session header — the signed
  // state is what proves which account this callback belongs to.
  app.get("/api/github/callback", async (req, res) => {
    if (!gh.isConfigured() || !supabaseAdmin) return res.status(503).send("GitHub sync isn't configured.");
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect("/app?github=denied");
    const userId = gh.verifyState(state);
    if (!code || !userId) return res.redirect("/app?github=badstate");

    try {
      const tok = await gh.exchangeCode(code);
      const viewer = await gh.getViewer(tok.access_token);
      await supabaseAdmin.from("github_connections").upsert({
        user_id: userId,
        github_id: viewer.id,
        github_login: viewer.login,
        access_token: gh.encrypt(tok.access_token),
        refresh_token: gh.encrypt(tok.refresh_token || null),
        token_expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
        scope: tok.scope || null,
        updated_at: new Date().toISOString(),
      });
      res.redirect("/app?github=connected");
    } catch (err) {
      console.error("GitHub callback failed:", err.message);
      res.redirect("/app?github=failed");
    }
  });

  app.get("/api/github/status", async (req, res) => {
    if (!gh.isConfigured() || !supabaseAdmin) return res.json({ available: false, connected: false });
    const user = await getManagedUser(req);
    if (!user) return res.json({ available: true, connected: false });
    const { data } = await supabaseAdmin
      .from("github_connections")
      .select("github_login, scope, updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    res.json({
      available: true,
      connected: Boolean(data),
      login: data ? data.github_login : null,
      scope: data ? data.scope : null,
    });
  });

  app.post("/api/github/disconnect", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    // The stored token is dropped entirely. The grant still exists on GitHub's
    // side until revoked there, which the response tells the user about.
    await supabaseAdmin.from("github_connections").delete().eq("user_id", user.id);
    await supabaseAdmin.from("github_repo_links").delete().eq("user_id", user.id);
    res.json({
      disconnected: true,
      note: "Token deleted. To revoke access entirely, remove the app under GitHub → Settings → Applications.",
    });
  });

  /* ---------------- repositories ---------------- */

  app.get("/api/github/repos", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json({ repos: await gh.listRepos(t.token) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/github/repo", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { name, description, private: isPrivate } = req.body || {};
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name || "")) {
      return res.status(400).json({ error: "Repository names may only contain letters, numbers, dots, hyphens and underscores." });
    }
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json(await gh.createRepo(t.token, { name, description, private: isPrivate !== false }));
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------------- push / pull ---------------- */

  app.post("/api/github/push", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { owner, repo, branch = "main", files, message, projectKey = "default" } = req.body || {};
    if (!owner || !repo) return res.status(400).json({ error: "Choose a repository first." });
    if (!files || !Object.keys(files).length) return res.status(400).json({ error: "Nothing to push." });
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      const result = await gh.pushFiles(t.token, { owner, repo, branch, files, message });
      await supabaseAdmin
        .from("github_repo_links")
        .upsert({ user_id: user.id, project_key: projectKey, owner, repo, branch, updated_at: new Date().toISOString() });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/github/pull", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { owner, repo, branch = "main" } = req.body || {};
    if (!owner || !repo) return res.status(400).json({ error: "Choose a repository first." });
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json(await gh.pullFiles(t.token, { owner, repo, branch }));
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------------- history / branches ---------------- */

  app.get("/api/github/commits", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { owner, repo, branch = "main" } = req.query;
    if (!owner || !repo) return res.status(400).json({ error: "Choose a repository first." });
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json({ commits: await gh.listCommits(t.token, { owner, repo, branch }) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/github/branches", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { owner, repo } = req.query;
    if (!owner || !repo) return res.status(400).json({ error: "Choose a repository first." });
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json({ branches: await gh.listBranches(t.token, { owner, repo }) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/github/branch", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { owner, repo, name, from = "main" } = req.body || {};
    if (!owner || !repo) return res.status(400).json({ error: "Choose a repository first." });
    if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(name || "")) return res.status(400).json({ error: "Invalid branch name." });
    const t = await tokenFor(user.id);
    if (!t) return res.status(403).json({ error: "Reconnect your GitHub account." });
    try {
      res.json(await gh.createBranch(t.token, { owner, repo, name, from }));
    } catch (err) {
      fail(res, err);
    }
  });
}

module.exports = { registerGithubRoutes };
