"use strict";

/* ---------------- Phase 3A: deploy to your own Vercel account ----------------
 * VibeSafe hosting is fine for showing someone what you built. Deploying to
 * Vercel is what makes it yours: your account, your domain, your bill, and it
 * keeps working if this builder never loads again.
 *
 * Multi-file projects only. Vercel builds from source — it runs npm install and
 * vite build on what we upload — so a project needs a package.json to deploy.
 * A single HTML file has nothing to build.
 *
 * The access token is never held here. It is posted once at connect time and
 * from then on this file only ever sees a masked hint of it.
 */

const vercel = {
  connected: false,
  projectName: null,
  protection: null,
  polling: null,

  async init() {
    await this.refresh();
    this.bind();
  },

  bind() {
    $("vcConnectBtn")?.addEventListener("click", () => this.connect());
    $("vcDisconnectBtn")?.addEventListener("click", () => this.disconnect());
    $("vcTestBtn")?.addEventListener("click", () => this.test());
    $("vcDeployPreviewBtn")?.addEventListener("click", () => this.deploy("preview"));
    $("vcDeployProdBtn")?.addEventListener("click", () => this.deploy("production"));
    $("vcToken")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.connect();
    });
  },

  async api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(await managed.headers()) };
    const r = await fetch(path, { ...opts, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Vercel request failed");
    return data;
  },

  status(msg, kind = "") {
    const el = $("vcStatus");
    if (!el) return;
    el.className = "gh-status " + kind;
    el.innerHTML = msg;
  },

  /* ---------------- panel state ---------------- */

  // Local only — no network. Called on every re-render, so it must stay cheap.
  // Availability is about the project, not the account: there is nothing to
  // deploy from a single HTML file even with Vercel perfectly connected.
  render() {
    const panel = $("vcPanel");
    const unavailable = $("vcUnavailable");
    if (!panel) return false;
    const usable = typeof isMulti === "function" && isMulti();
    panel.hidden = !usable;
    if (unavailable) unavailable.hidden = usable;
    if (!usable) return false;

    // Signed out of VibeSafe entirely — don't ask about Vercel yet.
    if (!managed?.session) {
      $("vcSignedOut").hidden = false;
      $("vcSignedIn").hidden = true;
      return false;
    }
    return true;
  },

  // Hits the server. Called when the session changes or the user acts, not on
  // every render.
  async refresh() {
    if (!this.render()) return;

    try {
      const s = await this.api("/api/vercel/status");
      this.connected = Boolean(s.connected);
      this.projectName = s.projectName || null;
      this.protection = s.protection || null;

      $("vcSignedOut").hidden = this.connected;
      $("vcSignedIn").hidden = !this.connected;

      if (this.connected) {
        $("vcProject").textContent = s.projectName || "your project";
        $("vcTokenHint").textContent = s.tokenHint || "";
        this.renderScope(s.scope);
        this.renderProtection();
        this.loadHistory();
      }
    } catch {
      // A failed status check is not worth an error message — the panel simply
      // shows the disconnected state.
      $("vcSignedOut").hidden = false;
      $("vcSignedIn").hidden = true;
    }
  },

  renderScope(scope) {
    const el = $("vcScope");
    if (!el) return;
    if (scope === "project") {
      el.className = "vc-scope ok";
      el.innerHTML = "🔒 This token can only reach this one project — the safest setup.";
    } else {
      el.className = "vc-scope warn";
      el.innerHTML =
        scope === "team"
          ? "⚠ This token can reach every project in your team. A project-scoped token would be safer."
          : "⚠ This token can reach your whole Vercel account, including other projects and their environment variables. A project-scoped token would be much safer.";
    }
  },

  // Phase 3A reports protection and stops there. Turning off someone's security
  // setting is not something to do quietly as a side effect of "Deploy".
  renderProtection() {
    const el = $("vcProtection");
    if (!el) return;
    const p = this.protection;
    if (!p || p.protected === null) {
      el.hidden = true;
      return;
    }
    if (!p.protected) {
      el.hidden = false;
      el.className = "vc-protection open";
      el.innerHTML =
        "🌐 <strong>This project is publicly visible.</strong> Anyone with the link can open it." +
        '<div class="vc-protection-actions"><button class="btn ghost mini" type="button" id="vcMakePrivateBtn">Make private…</button></div>';
      $("vcMakePrivateBtn").onclick = () => this.askConfirm("enable");
      return;
    }
    el.hidden = false;
    el.className = "vc-protection locked";
    // The server's explanation is a complete sentence on purpose — don't add a
    // lead-in that repeats it.
    el.innerHTML =
      "🔐 <strong>" +
      esc(p.explanation || "This project is protected.") +
      "</strong><br><span class='gh-meta'>Deploying still works — visitors just can't see the result yet.</span>" +
      '<div class="vc-protection-actions"><button class="btn ghost mini" type="button" id="vcMakePublicBtn">Make public…</button></div>';
    $("vcMakePublicBtn").onclick = () => this.askConfirm("disable");
  },

  /* ---------------- Phase 3B: changing protection ---------------- */

  // Deliberately not a one-click action and deliberately not a confirm() the
  // user can dismiss on autopilot. Turning protection off publishes the site to
  // everyone, so it asks for the project name to be typed — which also means
  // the person can see exactly which project they are about to change.
  askConfirm(action) {
    const el = $("vcConfirm");
    if (!el) return;
    const name = this.projectName || "";
    const goingPublic = action === "disable";

    el.hidden = false;
    el.className = "vc-confirm " + (goingPublic ? "danger" : "safe");
    el.innerHTML = goingPublic
      ? `<p><strong>Make “${esc(name)}” public?</strong></p>
         <p>Anyone with the link will be able to open this site — no Vercel account, no login. Search engines may index it.</p>
         <p class="gh-meta">This changes Deployment Protection on <strong>${esc(name)}</strong> only. No other Vercel project is affected, and you can put it back at any time.</p>
         <label class="gh-meta">Type <strong>${esc(name)}</strong> to confirm</label>
         <div class="gh-row">
           <input type="text" id="vcConfirmInput" autocomplete="off" spellcheck="false" placeholder="${esc(name)}" />
           <button class="btn primary" type="button" id="vcConfirmBtn">Make public</button>
           <button class="btn ghost" type="button" id="vcCancelBtn">Cancel</button>
         </div>`
      : `<p><strong>Make “${esc(name)}” private again?</strong></p>
         <p>Visitors will be asked to log in to Vercel before they can see the site. Anyone you shared the link with will lose access.</p>
         <p class="gh-meta">This restores the protection setting this project had before.</p>
         <label class="gh-meta">Type <strong>${esc(name)}</strong> to confirm</label>
         <div class="gh-row">
           <input type="text" id="vcConfirmInput" autocomplete="off" spellcheck="false" placeholder="${esc(name)}" />
           <button class="btn primary" type="button" id="vcConfirmBtn">Make private</button>
           <button class="btn ghost" type="button" id="vcCancelBtn">Cancel</button>
         </div>`;

    const input = $("vcConfirmInput");
    const go = $("vcConfirmBtn");
    // The button stays dead until the name matches, so the confirmation cannot
    // be clicked through without reading it.
    const sync = () => (go.disabled = input.value.trim() !== name);
    sync();
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !go.disabled) this.applyProtection(action, input.value);
    });
    go.onclick = () => this.applyProtection(action, input.value);
    $("vcCancelBtn").onclick = () => {
      el.hidden = true;
      el.innerHTML = "";
    };
    input.focus();
  },

  async applyProtection(action, confirmProjectName) {
    const el = $("vcConfirm");
    this.status(action === "disable" ? "Making the project public…" : "Restoring protection…");
    try {
      const r = await this.api("/api/vercel/protection", {
        method: "POST",
        body: JSON.stringify({ action, confirmProjectName }),
      });

      if (el) {
        el.hidden = true;
        el.innerHTML = "";
      }

      if (!r.applied) {
        this.status(esc(r.error || "The change did not take effect."), "error");
        await this.refresh();
        return;
      }

      // Report what was actually observed, not what was requested. The setting
      // changing and the site being reachable are two different facts.
      if (action === "disable") {
        if (r.access && r.access.public) {
          this.status("✓ The site is public — " + esc(r.access.reason), "ok");
          addMsg("system", "🌐 <strong>" + esc(this.projectName) + " is now public.</strong> Anyone with the link can open it.");
        } else {
          this.status(
            "⚠ Protection is off, but " + esc((r.access && r.access.reason) || "the site still isn't reachable."),
            "error"
          );
        }
      } else {
        this.status("🔐 Protection restored — visitors must log in to Vercel again.", "ok");
        addMsg("system", "🔐 <strong>" + esc(this.projectName) + " is private again.</strong>");
      }
      await this.refresh();
    } catch (err) {
      this.status(esc(err.message), "error");
    }
  },

  /* ---------------- connecting ---------------- */

  async connect() {
    const input = $("vcToken");
    const token = (input?.value || "").trim();
    if (!token) {
      this.status("Paste your Vercel token first.", "error");
      return;
    }
    this.status("Checking that token…");
    try {
      const r = await this.api("/api/vercel/connect", { method: "POST", body: JSON.stringify({ token }) });

      if (r.needsProject) {
        // A broad token can see several projects, so it has to be told which.
        this.pendingToken = token;
        this.showProjectPicker(r.projects);
        return;
      }
      // Clear the field the moment it is no longer needed — there is no reason
      // for a live credential to sit in the DOM.
      if (input) input.value = "";
      this.pendingToken = null;
      await this.refresh();
      addMsg("system", "✓ <strong>Vercel connected</strong> — deploying to <strong>" + esc(r.projectName) + "</strong>.");
    } catch (err) {
      this.status(esc(err.message), "error");
    }
  },

  showProjectPicker(projects) {
    const sel = $("vcProjectSelect");
    const row = $("vcProjectRow");
    if (!sel || !row) return;
    sel.innerHTML = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    row.hidden = false;
    this.status("That token can see several projects. Choose which one to deploy to.");
    $("vcProjectConfirmBtn").onclick = async () => {
      try {
        const r = await this.api("/api/vercel/connect", {
          method: "POST",
          body: JSON.stringify({ token: this.pendingToken, projectId: sel.value }),
        });
        this.pendingToken = null;
        if ($("vcToken")) $("vcToken").value = "";
        row.hidden = true;
        await this.refresh();
        addMsg("system", "✓ <strong>Vercel connected</strong> — deploying to <strong>" + esc(r.projectName) + "</strong>.");
      } catch (err) {
        this.status(esc(err.message), "error");
      }
    };
  },

  async test() {
    this.status("Testing the connection…");
    try {
      const r = await this.api("/api/vercel/test", { method: "POST" });
      if (r.ok) this.status("✓ Connection works — <strong>" + esc(r.projectName) + "</strong> is reachable.", "ok");
      else this.status(esc(r.error || "The connection no longer works."), "error");
    } catch (err) {
      this.status(esc(err.message), "error");
    }
  },

  async disconnect() {
    if (!confirm("Disconnect Vercel? Your deployed sites stay online — this only removes the stored token from VibeSafe.")) return;
    try {
      await this.api("/api/vercel/disconnect", { method: "POST" });
      this.connected = false;
      await this.refresh();
      this.status("Vercel disconnected. Your deployed sites are unaffected.", "ok");
    } catch (err) {
      this.status(esc(err.message), "error");
    }
  },

  /* ---------------- deploying ---------------- */

  async deploy(environment) {
    const files = typeof currentFiles === "function" ? currentFiles() : null;
    if (!files || !Object.keys(files).length) {
      this.status("Generate a project first.", "error");
      return;
    }
    if (environment === "production") {
      if (!confirm(`Deploy to production on "${this.projectName}"? This replaces what's live at your project's main URL.`)) return;
    }

    this.setBusy(true);
    this.status(environment === "production" ? "Deploying to production…" : "Deploying a preview…");
    try {
      const dep = await this.api("/api/vercel/deploy", {
        method: "POST",
        body: JSON.stringify({ files, environment }),
      });
      this.protection = dep.protection || this.protection;
      this.renderProtection();
      this.pollBuild(dep, environment);
    } catch (err) {
      this.setBusy(false);
      this.status(esc(err.message), "error");
    }
  },

  // Vercel accepts the deployment immediately and builds asynchronously, so the
  // interesting outcome — did npm install and vite build actually succeed —
  // only arrives by polling.
  async pollBuild(dep, environment) {
    clearInterval(this.polling);
    let ticks = 0;
    const done = (msg, kind) => {
      clearInterval(this.polling);
      this.setBusy(false);
      this.status(msg, kind);
      this.loadHistory();
    };

    this.polling = setInterval(async () => {
      ticks++;
      if (ticks > 100) return done("The build is taking unusually long. Check it in your Vercel dashboard.", "error");
      let s;
      try {
        s = await this.api("/api/vercel/deployment/" + encodeURIComponent(dep.id));
      } catch {
        return; // a transient poll failure is not a failed build
      }

      if (s.state === "BUILDING" || s.state === "INITIALIZING" || s.state === "QUEUED") {
        this.status("Building on Vercel… <span class='gh-meta'>(" + esc(s.state.toLowerCase()) + ")</span>");
        return;
      }
      if (s.state === "ERROR") {
        return done("🛑 The build failed on Vercel. " + esc(s.error || "Check the build log in your Vercel dashboard."), "error");
      }
      if (s.state === "CANCELED") return done("The deployment was cancelled.", "error");

      if (s.state === "READY") {
        const link = `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>`;
        done("✓ Deployed — " + link, "ok");
        const label = environment === "production" ? "production" : "preview";
        addMsg("system", `🚀 <strong>Deployed to Vercel</strong> (${label}) — ${link}`);
        // Said plainly here too, because a link that shows a Vercel login page
        // reads as a broken deployment unless we explain it.
        if (this.protection && this.protection.protected) {
          addMsg(
            "system",
            "🔐 That URL is behind Deployment Protection, so visitors will be asked to log in to Vercel before they can see it. Turn protection off in your Vercel project settings to make it public."
          );
        }
      }
    }, 3000);
  },

  setBusy(busy) {
    for (const id of ["vcDeployPreviewBtn", "vcDeployProdBtn", "vcDisconnectBtn", "vcTestBtn"]) {
      const b = $(id);
      if (b) b.disabled = busy;
    }
  },

  async loadHistory() {
    const el = $("vcDeployments");
    if (!el) return;
    try {
      const r = await this.api("/api/vercel/deployments");
      if (!r.deployments.length) {
        el.innerHTML = "<li class='gh-meta'>No deployments yet.</li>";
        return;
      }
      el.innerHTML = r.deployments
        .map((d) => {
          const when = d.createdAt ? new Date(d.createdAt).toLocaleString() : "";
          const state = d.state === "READY" ? "✓" : d.state === "ERROR" ? "🛑" : "…";
          return `<li>${state} <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.target)}</a> <span class="gh-meta">${esc(when)}</span></li>`;
        })
        .join("");
    } catch {
      el.innerHTML = "<li class='gh-meta'>Could not load deployment history.</li>";
    }
  },
};

window.vercel = vercel;
vercel.init();
