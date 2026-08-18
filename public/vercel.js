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
    if (!r.ok) {
      const err = new Error(data.error || data.reason || "Vercel request failed");
      // A 422 is Launch Check refusing, not a transport failure — the body
      // carries the findings the user needs, so it must survive the throw.
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  /* ---------------- Launch Check results ---------------- */

  // A block with no explanation is useless: the user needs the file, the line,
  // and what to do. The secret itself is never shown — the server masks it
  // before it leaves, and we do not un-mask it here.
  renderScan(data) {
    const el = $("vcConfirm");
    if (!el) return;
    const scan = data.scan || { findings: [], counts: {} };
    const icon = { critical: "🔴", high: "🟠", medium: "🟡", info: "🔵" };

    const rows = scan.findings
      .slice(0, 12)
      .map(
        (f) =>
          `<li class="vc-finding ${esc(f.severity)}">
             <div>${icon[f.severity] || "•"} <strong>${esc(f.label)}</strong></div>
             <div class="gh-meta">${esc(f.file)}:${f.line}</div>
             ${f.snippet ? `<pre class="vc-snippet">${esc(f.snippet)}</pre>` : ""}
             <div class="gh-meta">${esc(f.remediation || "")}</div>
           </li>`
      )
      .join("");

    const more = scan.findings.length > 12 ? `<p class="gh-meta">…and ${scan.findings.length - 12} more.</p>` : "";

    el.hidden = false;
    el.className = "vc-confirm danger";
    el.innerHTML =
      `<p><strong>🛑 Launch Check stopped this.</strong></p>
       <p>${esc(data.reason || "")}</p>
       <ul class="vc-findings">${rows}</ul>${more}` +
      (data.overridable
        ? `<p class="gh-meta">These are judgement calls rather than leaked credentials. If you've reviewed them and want to continue anyway:</p>
           <div class="gh-row">
             <button class="btn ghost" type="button" id="vcOverrideBtn">Continue anyway</button>
             <button class="btn ghost" type="button" id="vcCancelBtn">Cancel</button>
           </div>`
        : `<p class="gh-meta"><strong>Fix these before publishing.</strong> A credential in a public site is compromised the moment anyone visits — remove it from the code <em>and</em> rotate it, since it may already have been pushed to GitHub.</p>
           <div class="gh-row"><button class="btn ghost" type="button" id="vcCancelBtn">Close</button></div>`);

    $("vcCancelBtn").onclick = () => {
      el.hidden = true;
      el.innerHTML = "";
    };
    // Only offered when the server said the finding is overridable. There is no
    // client-side path to overriding a critical one.
    if (data.overridable && $("vcOverrideBtn")) {
      $("vcOverrideBtn").onclick = () => {
        el.hidden = true;
        el.innerHTML = "";
        if (this.pendingAction) this.pendingAction(true);
      };
    }
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

  async applyProtection(action, confirmProjectName, acknowledgeWarnings = false) {
    const el = $("vcConfirm");
    // Make Public re-runs Launch Check server-side against the CURRENT files —
    // a project that passed at deploy time may not pass now.
    const files = typeof currentFiles === "function" ? currentFiles() : null;
    this.pendingAction = (ack) => this.applyProtection(action, confirmProjectName, ack);

    this.status(action === "disable" ? "Running Launch Check…" : "Restoring protection…");
    try {
      const r = await this.api("/api/vercel/protection", {
        method: "POST",
        body: JSON.stringify({ action, confirmProjectName, files, acknowledgeWarnings }),
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
      if (err.status === 422 && err.data && err.data.blocked) {
        this.status("🛑 Launch Check blocked this — the project was not made public.", "error");
        this.renderScan(err.data);
        return;
      }
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

  async deploy(environment, acknowledgeWarnings = false) {
    const files = typeof currentFiles === "function" ? currentFiles() : null;
    if (!files || !Object.keys(files).length) {
      this.status("Generate a project first.", "error");
      return;
    }
    if (environment === "production" && !acknowledgeWarnings) {
      if (!confirm(`Deploy to production on "${this.projectName}"? This replaces what's live at your project's main URL.`)) return;
    }
    // Remembered so "Continue anyway" can retry the same action with the
    // acknowledgement set, rather than the user starting over.
    this.pendingAction = (ack) => this.deploy(environment, ack);

    this.setBusy(true);
    this.status(environment === "production" ? "Running Launch Check…" : "Running Launch Check…");
    try {
      const dep = await this.api("/api/vercel/deploy", {
        method: "POST",
        body: JSON.stringify({ files, environment, acknowledgeWarnings }),
      });
      this.protection = dep.protection || this.protection;
      this.renderProtection();
      this.pollBuild(dep, environment);
    } catch (err) {
      this.setBusy(false);
      if (err.status === 422 && err.data && err.data.blocked) {
        this.status("🛑 Launch Check blocked this deployment.", "error");
        this.renderScan(err.data);
        return;
      }
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
