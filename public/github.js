"use strict";

/* ---------------- Phase 2D: GitHub sync ----------------
 * Connect a GitHub account, push the project into a real repository, pull
 * changes back, and browse history and branches. The point is that a project
 * built here isn't trapped here.
 *
 * Multi-file projects only: a single-file app is one HTML document, which git
 * handles fine on its own but which has no meaningful "project" to sync.
 */

const gh = {
  connected: false,
  login: null,
  link: null, // { owner, repo, branch }

  async init() {
    // The OAuth callback bounces back to /app?github=… — report the outcome and
    // clean the URL so a refresh doesn't repeat the message.
    const params = new URLSearchParams(location.search);
    const result = params.get("github");
    if (result) {
      const msg = {
        connected: "✓ <strong>GitHub connected.</strong> You can now push this project to a repository.",
        denied: "GitHub connection cancelled — nothing was changed.",
        badstate: "That GitHub link expired. Try connecting again.",
        failed: "🛑 GitHub connection failed. Try again, or check the app's permissions on GitHub.",
      }[result];
      if (msg) addMsg("system", msg);
      history.replaceState({}, "", location.pathname);
    }
    await this.refresh();
    this.bind();
  },

  bind() {
    $("ghConnectBtn")?.addEventListener("click", () => this.connect());
    $("ghDisconnectBtn")?.addEventListener("click", () => this.disconnect());
    $("ghPushBtn")?.addEventListener("click", () => this.push());
    $("ghPullBtn")?.addEventListener("click", () => this.pull());
    $("ghNewRepoBtn")?.addEventListener("click", () => this.createRepo());
    $("ghRepoSelect")?.addEventListener("change", () => {
      const v = $("ghRepoSelect").value;
      if (!v) return;
      const [owner, repo] = v.split("/");
      this.link = { owner, repo, branch: this.link?.branch || "main" };
      this.loadBranches();
      this.loadCommits();
    });
    $("ghBranchSelect")?.addEventListener("change", () => {
      if (this.link) this.link.branch = $("ghBranchSelect").value || "main";
      this.loadCommits();
    });
  },

  async api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(await managed.headers()) };
    const r = await fetch(path, { ...opts, headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "GitHub request failed");
    return data;
  },

  async refresh() {
    // managed.init() is async — it fetches /api/config, builds the Supabase
    // client, then restores the session. gh.init() runs at script load, well
    // before that finishes, so without waiting the status call goes out with no
    // x-vc-session header and the server correctly answers "not connected" for
    // an account that IS connected. That's why a connected user was still shown
    // the Connect button after a reload.
    for (let i = 0; i < 60 && !managed.sb; i++) await new Promise((r) => setTimeout(r, 50));
    try {
      const s = await this.api("/api/github/status");
      this.connected = s.connected;
      this.login = s.login;
      this.available = s.available;
    } catch {
      this.connected = false;
    }
    this.render();
    if (this.connected) this.loadRepos();
  },

  render() {
    const panel = $("ghPanel");
    if (!panel) return;
    // Only meaningful for multi-file projects. The two halves are mutually
    // exclusive — previously only the panel was toggled, so the "this project is
    // a single HTML file" empty state stayed on screen underneath a working
    // panel, contradicting it.
    const usable = isMulti() && this.available;
    panel.hidden = !usable;
    const unavailable = $("ghUnavailable");
    if (unavailable) unavailable.hidden = usable;
    $("ghSignedOut").hidden = this.connected;
    $("ghSignedIn").hidden = !this.connected;
    if (this.connected) $("ghAccount").textContent = "@" + (this.login || "");
    const hasRepo = Boolean(this.link);
    $("ghPushBtn").disabled = !hasRepo;
    $("ghPullBtn").disabled = !hasRepo;
    $("ghBranchRow").hidden = !hasRepo;
  },

  status(msg, cls) {
    const el = $("ghStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "gh-status" + (cls ? " " + cls : "");
  },

  async connect() {
    try {
      const { url } = await this.api("/api/github/connect", { method: "POST" });
      // Full navigation, not a popup: the callback needs to land on our own
      // origin, and popups get blocked often enough to be unreliable.
      location.href = url;
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async disconnect() {
    if (!confirm("Disconnect GitHub? The stored token is deleted. Your repositories are untouched.")) return;
    try {
      const r = await this.api("/api/github/disconnect", { method: "POST" });
      this.connected = false;
      this.link = null;
      this.render();
      addMsg("system", "GitHub disconnected. " + (r.note || ""));
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async loadRepos() {
    try {
      const { repos } = await this.api("/api/github/repos");
      const sel = $("ghRepoSelect");
      if (!sel) return;
      sel.innerHTML =
        '<option value="">Choose a repository…</option>' +
        repos.map((r) => '<option value="' + esc(r.owner + "/" + r.repo) + '">' + esc(r.owner + "/" + r.repo) + (r.private ? " (private)" : "") + "</option>").join("");
      if (this.link) sel.value = this.link.owner + "/" + this.link.repo;
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async createRepo() {
    const name = prompt("New repository name:", "my-vibesafe-app");
    if (!name) return;
    this.status("Creating repository…");
    try {
      const r = await this.api("/api/github/repo", { method: "POST", body: JSON.stringify({ name, private: true }) });
      this.link = { owner: r.owner, repo: r.repo, branch: r.defaultBranch || "main" };
      await this.loadRepos();
      $("ghRepoSelect").value = r.owner + "/" + r.repo;
      this.render();
      this.loadBranches();
      addMsg("system", '✓ Created <a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.owner + "/" + r.repo) + "</a> (private). Push when you're ready.");
      this.status("");
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async loadBranches() {
    if (!this.link) return;
    try {
      const { branches } = await this.api(
        "/api/github/branches?owner=" + encodeURIComponent(this.link.owner) + "&repo=" + encodeURIComponent(this.link.repo)
      );
      const sel = $("ghBranchSelect");
      sel.innerHTML = branches.map((b) => '<option value="' + esc(b.name) + '">' + esc(b.name) + "</option>").join("");
      if (branches.some((b) => b.name === this.link.branch)) sel.value = this.link.branch;
      else this.link.branch = sel.value || "main";
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async loadCommits() {
    if (!this.link) return;
    try {
      const { commits } = await this.api(
        "/api/github/commits?owner=" + encodeURIComponent(this.link.owner) +
          "&repo=" + encodeURIComponent(this.link.repo) +
          "&branch=" + encodeURIComponent(this.link.branch)
      );
      const list = $("ghCommits");
      list.innerHTML = commits.length
        ? commits
            .map(
              (c) =>
                '<li><a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.sha.slice(0, 7)) + "</a> " +
                esc(c.message.split("\n")[0]).slice(0, 70) +
                '<span class="gh-meta">' + esc(c.author) + "</span></li>"
            )
            .join("")
        : "<li class='gh-meta'>No commits yet.</li>";
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async push() {
    if (!this.link) return;
    const message = prompt("Commit message:", "Update from VibeSafe Builder");
    if (!message) return;
    this.status("Pushing…");
    try {
      const r = await this.api("/api/github/push", {
        method: "POST",
        body: JSON.stringify({ ...this.link, files: currentFiles(), message, projectKey: state.publishId || "default" }),
      });
      this.status("Pushed " + r.files + " files", "ok");
      // Same gap Publish already closed for itself ("Republish any time to
      // update it") — a customer's first push gave no hint that Push is also
      // how you'd ship every later change, not a one-time action.
      addMsg(
        "system",
        "⬆ Pushed " +
          r.files +
          " files to " +
          esc(this.link.owner + "/" + this.link.repo) +
          " (" +
          esc(r.sha.slice(0, 7)) +
          "). Keep chatting to make changes, then <strong>Push</strong> again any time to update the repository."
      );
      this.loadCommits();
    } catch (err) {
      this.status(err.message, "error");
    }
  },

  async pull() {
    if (!this.link) return;
    if (!confirm("Pull from " + this.link.owner + "/" + this.link.repo + "? This replaces the current project files with what's in the repository.")) return;
    this.status("Pulling…");
    try {
      const r = await this.api("/api/github/pull", { method: "POST", body: JSON.stringify(this.link) });
      const count = Object.keys(r.files).length;
      if (!count) throw new Error("That branch has no files this builder can open.");
      // Lands as a new version, so pulling is undoable like any other change.
      state.versions.push({
        id: state.versions.length + 1,
        time: new Date().toLocaleTimeString(),
        prompt: "Pulled from GitHub",
        code: null,
        files: r.files,
        cost: 0,
        note: "Pulled " + count + " files from " + this.link.owner + "/" + this.link.repo,
      });
      state.currentVersion = state.versions.length - 1;
      state.activeFile = null;
      await renderAll();
      saveProject();
      this.status("Pulled " + count + " files", "ok");
      if (r.skipped && r.skipped.length) {
        addMsg("system", "⬇ Pulled " + count + " files. Skipped " + r.skipped.length + " that this builder can't open (binaries or oversized files).");
      } else {
        addMsg("system", "⬇ Pulled " + count + " files from " + esc(this.link.owner + "/" + this.link.repo) + ".");
      }
    } catch (err) {
      this.status(err.message, "error");
    }
  },
};

window.gh = gh;
gh.init();
