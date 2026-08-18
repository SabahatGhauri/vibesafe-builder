// Phase 3A — HTTP surface for deploying to a user's own Vercel account.
//
// Kept separate from lib/deployVercel.js for the same reason githubRoutes is
// separate from github.js: the provider stays a pure, testable library and this
// file holds only request handling, session checks and persistence.
//
// The token never crosses back to the browser. It goes in once, is encrypted
// immediately, and from then on the client sees only a masked hint. There is no
// route that returns a decrypted credential, deliberately — not even to the
// account that owns it.

const vercelLib = require("./deployVercel");

function registerVercelRoutes(app, { supabaseAdmin, getManagedUser }) {
  // Every route re-verifies the caller's Supabase session. Reaching the endpoint
  // is never enough: the credential being used belongs to whoever that session
  // says they are.
  async function requireUser(req, res) {
    const user = await getManagedUser(req);
    if (!user) {
      res.status(401).json({ error: "Sign in first." });
      return null;
    }
    return user;
  }

  function guard(res) {
    if (!supabaseAdmin) {
      res.status(503).json({ error: "Vercel deployment isn't configured on this server." });
      return false;
    }
    return true;
  }

  async function connectionFor(userId) {
    const { data, error } = await supabaseAdmin
      .from("vercel_connections")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const token = vercelLib.decrypt(data.access_token);
    // A null here means the encryption key changed. Treat it as "not connected"
    // so the user is asked to reconnect rather than shown a crash.
    return token ? { token, connection: data } : null;
  }

  // Records what happened, for the user's own audit trail. Never throws: a
  // logging failure must not turn a successful deployment into an error.
  async function record(userId, event, fields = {}) {
    try {
      await supabaseAdmin.from("deployment_events").insert({
        user_id: userId,
        provider: "vercel",
        event,
        ...fields,
      });
    } catch (err) {
      console.error("Could not record deployment event", event, err.message);
    }
  }

  function fail(res, err) {
    const status = err.status === 401 || err.status === 403 ? 403 : 400;
    const msg =
      err.status === 401 || err.status === 403
        ? "Vercel rejected the request. Your token may have been revoked — reconnect to continue."
        : err.status === 404
        ? "Vercel couldn't find that project. The token may not have access to it."
        : err.message || "Vercel request failed";
    res.status(status).json({ error: msg });
  }

  /* ---------------- connect / status / disconnect ---------------- */

  // Validating BEFORE storing means a typo is reported immediately instead of
  // failing later at deploy time with nothing to point at.
  app.post("/api/vercel/connect", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;

    const token = (req.body && req.body.token ? String(req.body.token) : "").trim();
    if (!token) return res.status(400).json({ error: "Paste your Vercel token." });

    const info = await vercelLib.inspectToken(token);
    if (!info.ok) return res.status(400).json({ error: info.error });
    if (!info.projects.length) {
      return res.status(400).json({
        error: "That token works, but it can't see any Vercel projects. Create a project on Vercel first.",
      });
    }

    // With a project-scoped token the project is implied, which is the case we
    // want people in. A broader token still has to pick one.
    const chosen =
      info.projects.find((p) => p.id === (req.body && req.body.projectId)) ||
      (info.projects.length === 1 ? info.projects[0] : null);

    if (!chosen) {
      // Not an error — the client shows a picker and posts back with projectId.
      return res.json({ needsProject: true, projects: info.projects, scope: info.scope, warning: info.warning });
    }

    const row = {
      user_id: user.id,
      access_token: vercelLib.encrypt(token),
      token_hint: vercelLib.hint(token),
      token_scope: info.scope,
      project_id: chosen.id,
      project_name: chosen.name,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from("vercel_connections").upsert(row, { onConflict: "user_id" });
    if (error) return res.status(500).json({ error: "Could not save the connection." });

    res.json({
      connected: true,
      projectName: chosen.name,
      projectId: chosen.id,
      scope: info.scope,
      tokenHint: row.token_hint,
      warning: info.warning,
    });
  });

  app.get("/api/vercel/status", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const c = await connectionFor(user.id);
    if (!c) return res.json({ connected: false });

    const status = await vercelLib.vercel.status({ connection: c.connection });
    // Protection state is read live rather than cached: the user may have
    // changed it in Vercel's own dashboard since we last looked.
    const protection = await vercelLib.getProtection(c.token, c.connection.project_id);
    res.json({ ...status, protection });
  });

  // "Test connection" — proves the stored credential still works, and reports
  // what it can reach, without deploying anything.
  app.post("/api/vercel/test", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const c = await connectionFor(user.id);
    if (!c) return res.status(403).json({ error: "Connect your Vercel account first." });

    const info = await vercelLib.inspectToken(c.token);
    if (!info.ok) return res.status(403).json({ ok: false, error: info.error });
    const reachable = info.projects.some((p) => p.id === c.connection.project_id);
    res.json({
      ok: reachable,
      scope: info.scope,
      warning: info.warning,
      projectName: c.connection.project_name,
      error: reachable ? null : "The token can no longer reach that project. Reconnect to fix it.",
    });
  });

  app.post("/api/vercel/disconnect", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { error } = await supabaseAdmin.from("vercel_connections").delete().eq("user_id", user.id);
    if (error) return res.status(500).json({ error: "Could not disconnect." });
    // The event log deliberately outlives the connection.
    await record(user.id, "disconnect");
    res.json({ disconnected: true });
  });

  /* ---------------- deploying ---------------- */

  app.post("/api/vercel/deploy", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const c = await connectionFor(user.id);
    if (!c) return res.status(403).json({ error: "Connect your Vercel account first." });

    const { files, environment = "preview" } = req.body || {};
    if (!files || typeof files !== "object" || !Object.keys(files).length) {
      return res.status(400).json({ error: "Nothing to deploy." });
    }
    if (environment !== "preview" && environment !== "production") {
      return res.status(400).json({ error: "Unknown environment." });
    }

    try {
      const dep = await vercelLib.vercel.deploy(
        { vercelToken: c.token },
        { files, environment, projectName: c.connection.project_name }
      );

      await record(user.id, "deploy", {
        project_id: c.connection.project_id,
        project_name: c.connection.project_name,
        deployment_id: dep.id,
        url: dep.url,
        environment,
        detail: { fileCount: Object.keys(files).length },
      });

      // Reported alongside the deployment, because a URL that asks visitors to
      // log in to Vercel looks broken unless we say why. Phase 3A only tells
      // them; changing the setting is a separate, explicitly confirmed action.
      const protection = await vercelLib.getProtection(c.token, c.connection.project_id);
      res.json({ ...dep, protection });
    } catch (err) {
      fail(res, err);
    }
  });

  // Polled by the client while a build runs. Vercel reports build FAILURES in
  // the body with a 200, so an error here is a transport problem, not a failed
  // build — the two are kept distinct.
  app.get("/api/vercel/deployment/:id", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const c = await connectionFor(user.id);
    if (!c) return res.status(403).json({ error: "Connect your Vercel account first." });
    try {
      res.json(await vercelLib.getDeployment(c.token, req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/vercel/deployments", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const c = await connectionFor(user.id);
    if (!c) return res.status(403).json({ error: "Connect your Vercel account first." });
    try {
      res.json({ deployments: await vercelLib.listDeployments(c.token, { projectId: c.connection.project_id }) });
    } catch (err) {
      fail(res, err);
    }
  });

  // The user's own audit trail, readable by them.
  app.get("/api/vercel/events", async (req, res) => {
    if (!guard(res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const { data, error } = await supabaseAdmin
      .from("deployment_events")
      .select("event, project_name, url, environment, detail, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: "Could not load the activity log." });
    res.json({ events: data || [] });
  });
}

module.exports = { registerVercelRoutes };
