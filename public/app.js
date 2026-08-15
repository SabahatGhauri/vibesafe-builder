"use strict";

/* ---------------- state ---------------- */
const state = {
  apiKey: localStorage.getItem("vc_apiKey") || "",
  cap: parseFloat(localStorage.getItem("vc_cap") || "5"),
  spend: 0,        // successful generations only
  wasted: 0,       // failed generations — shown separately, never counted as "build spend"
  versions: [],    // {id, time, prompt, code, cost, note}
  currentVersion: -1,
  fixFailStreak: 0,
  lastWasFixRequest: false,
  busy: false,
  publishId: null,
  launchCheck: null, // { forVersion, result } — result is tied to a specific version, not persisted (screenshots are heavy)
};

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");

/* ---------------- managed plan (Supabase magic-link sign-in) ---------------- */
const managed = {
  sb: null,
  session: null, // cached Supabase session, kept in sync by onAuthStateChange
  budget: 10,

  async init() {
    try {
      const cfg = await (await fetch("/api/config")).json();
      if (!cfg.managedPlanAvailable) return;
      this.budget = cfg.managedBudget || 10;
      this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const { data } = await this.sb.auth.getSession();
      this.session = data.session;
      this.sb.auth.onAuthStateChange((_event, session) => {
        this.session = session;
        this.renderStatus();
      });
      this.renderStatus();
    } catch {
      // Managed plan simply unavailable (e.g. not configured on this server) — BYOK still works.
    }
  },

  isSignedIn() {
    return !!this.session;
  },

  // Merges in the managed-session header when signed in — server checks this
  // before falling back to x-anthropic-key, so callers can just always call this.
  async headers() {
    if (!this.sb) return {};
    const { data } = await this.sb.auth.getSession();
    this.session = data.session;
    return this.session ? { "x-vc-session": this.session.access_token } : {};
  },

  renderStatus() {
    const signedOut = $("managedSignedOut");
    const signedIn = $("managedSignedIn");
    const badge = $("planBadge");
    if (!signedOut || !signedIn) return;
    if (this.session) {
      signedOut.hidden = true;
      signedIn.hidden = false;
      $("managedSignedInAs").textContent = `Signed in as ${this.session.user.email}`;
      this.refreshPlanStatus();
    } else {
      signedOut.hidden = false;
      signedIn.hidden = true;
      if (badge) badge.hidden = true;
    }
  },

  // Shows Pro vs Free clearly up front — both in the header badge (always visible)
  // and in Settings (where the sign-in controls live) — instead of only surfacing
  // plan status indirectly when a generation gets rejected for lacking one.
  async refreshPlanStatus() {
    const badge = $("planBadge");
    const settingsLine = $("managedSignedInPlan");
    if (!this.sb) return;
    try {
      const { data } = await this.sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const r = await fetch("/api/managed/status", { headers: { "x-vc-session": token } });
      const status = await r.json();
      if (!status.signedIn) return;
      const label = status.plan === "pro" ? "Pro" : "Free";
      const who = status.name || status.email;
      if (badge) {
        badge.hidden = false;
        badge.className = `plan-badge ${status.plan}`;
        badge.innerHTML = `<span class="dot"></span>${label}<span class="name">· ${esc(who)}</span>`;
      }
      if (settingsLine) {
        settingsLine.textContent = status.plan === "pro"
          ? `✓ Pro — active (${fmt$(status.spent)} of ${fmt$(status.budget)} used this month)`
          : "⚠ Free — no active subscription. Pay for managed access to unlock Pro.";
      }
    } catch {
      // Non-fatal — badge just stays hidden/stale if this fails; sign-in itself is unaffected.
    }
  },

  async sendMagicLink(email) {
    if (!this.sb) throw new Error("Managed plan isn't available right now.");
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + "/app", shouldCreateUser: false },
    });
    if (error) throw error;
  },

  async signOut() {
    if (this.sb) await this.sb.auth.signOut();
  },
};
managed.init();

$("sendMagicLinkBtn")?.addEventListener("click", async () => {
  const email = $("managedEmailInput").value.trim();
  const status = $("magicLinkStatus");
  if (!email) { status.textContent = "Enter your email first."; return; }
  status.textContent = "Sending…";
  try {
    await managed.sendMagicLink(email);
    status.textContent = "Check your email for a sign-in link.";
  } catch (err) {
    status.textContent = err.message?.includes("Signups not allowed")
      ? "That email hasn't paid for the managed plan yet."
      : "Couldn't send link: " + (err.message || "unknown error");
  }
});
$("signOutBtn")?.addEventListener("click", async () => {
  await managed.signOut();
});

/* ---------------- persistence (survives reloads) ---------------- */
const PROJECT_KEY = "vc_project";

function saveProject() {
  const payload = {
    versions: state.versions.slice(-20), // cap for localStorage quota
    currentVersion: Math.min(state.currentVersion, 19),
    spend: state.spend,
    wasted: state.wasted,
    publishId: state.publishId,
    chatHTML: messagesEl.innerHTML,
  };
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(payload));
  } catch {
    // quota hit — drop older versions and retry once
    payload.versions = payload.versions.slice(-5);
    payload.currentVersion = Math.min(payload.currentVersion, 4);
    try { localStorage.setItem(PROJECT_KEY, JSON.stringify(payload)); } catch { /* give up quietly */ }
  }
}

function loadProject() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw);
    if (!Array.isArray(p.versions) || p.versions.length === 0) return false;
    state.versions = p.versions;
    state.currentVersion = typeof p.currentVersion === "number" ? p.currentVersion : p.versions.length - 1;
    state.spend = p.spend || 0;
    state.wasted = p.wasted || 0;
    state.publishId = p.publishId || null;
    if (p.chatHTML) messagesEl.innerHTML = p.chatHTML;
    return true;
  } catch {
    return false;
  }
}

/* ---------------- settings ---------------- */
$("settingsBtn").addEventListener("click", () => {
  $("apiKeyInput").value = state.apiKey;
  $("capInput").value = state.cap;
  $("settingsModal").showModal();
});
$("settingsModal").addEventListener("close", () => {
  if ($("settingsModal").returnValue !== "save") return;
  state.apiKey = $("apiKeyInput").value.trim();
  state.cap = Math.max(0.5, parseFloat($("capInput").value) || 5);
  localStorage.setItem("vc_apiKey", state.apiKey);
  localStorage.setItem("vc_cap", String(state.cap));
  renderMeter();
  refreshEstimate();
});

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("panel-" + tab.dataset.tab).classList.add("active");
  });
});

/* ---------------- chat helpers ---------------- */
function addMsg(cls, html) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt$ = (n) => "$" + n.toFixed(n < 0.1 ? 3 : 2);

/* ---------------- meter ---------------- */
function renderMeter() {
  $("meterSpend").textContent = fmt$(state.spend);
  $("meterCap").textContent = fmt$(state.cap);
  const pct = Math.min(100, (state.spend / state.cap) * 100);
  const fill = $("meterFill");
  fill.style.width = pct + "%";
  fill.className = "meter-fill" + (pct >= 100 ? " over" : pct >= 75 ? " hot" : "");
  $("meterWasted").hidden = state.wasted === 0;
  $("wastedVal").textContent = fmt$(state.wasted);
}

/* ---------------- cost estimate (debounced, live) ---------------- */
let estTimer = null;
let lastEstimate = null;
$("promptInput").addEventListener("input", () => {
  clearTimeout(estTimer);
  estTimer = setTimeout(refreshEstimate, 700);
});

async function refreshEstimate() {
  const prompt = $("promptInput").value.trim();
  const estEl = $("estimate");
  lastEstimate = null;
  if (!prompt) { estEl.textContent = "est. —"; estEl.classList.remove("blocked"); return; }
  if (!state.apiKey && !managed.isSignedIn()) { estEl.textContent = "add API key or sign in to managed plan in Settings"; return; }
  estEl.textContent = "estimating…";
  try {
    const managedHeaders = await managed.headers();
    const r = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-anthropic-key": state.apiKey, ...managedHeaders },
      body: JSON.stringify({ prompt, currentCode: currentCode() }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
    const est = await r.json();
    lastEstimate = est;
    if (est.mode === "managed") {
      // Managed plan: show builds used, not raw dollars — that's a flat-fee
      // subscription, not a pass-through bill like BYOK.
      const remaining = Math.max(0, est.budget - est.spent);
      estEl.textContent = remaining < est.high
        ? `⚠ close to this month's included usage (${fmt$(est.spent)} of ${fmt$(est.budget)} used)`
        : `managed plan — ${est.buildsThisMonth} build${est.buildsThisMonth === 1 ? "" : "s"} used this month`;
      estEl.classList.toggle("blocked", remaining < est.high);
    } else if (state.spend + est.high > state.cap) {
      estEl.textContent = `est. ${fmt$(est.low)}–${fmt$(est.high)} — would exceed your ${fmt$(state.cap)} cap`;
      estEl.classList.add("blocked");
    } else {
      estEl.textContent = `est. ${fmt$(est.low)}–${fmt$(est.high)} for this generation`;
      estEl.classList.remove("blocked");
    }
  } catch (e) {
    estEl.textContent = "est. unavailable (" + e.message + ")";
  }
}

/* ---------------- generation ---------------- */
const currentCode = () =>
  state.currentVersion >= 0 ? state.versions[state.currentVersion].code : "";

const FIX_WORDS = /\b(still|again|didn'?t|doesn'?t work|not work|broken|same (bug|issue|error|problem)|no change|nothing happen)/i;

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const prompt = $("promptInput").value.trim();
  if (!prompt) return;
  if (!state.apiKey && !managed.isSignedIn()) { $("settingsModal").showModal(); return; }

  // Spend-cap guard (fix #5: hard cap, checked before spending) — BYOK only;
  // the managed plan has its own server-enforced budget checked in /api/generate.
  if (!managed.isSignedIn() && lastEstimate && state.spend + lastEstimate.high > state.cap) {
    addMsg("system", `⛔ Blocked: this generation could push you past your ${fmt$(state.cap)} cap. Raise the cap in Settings if you want to continue.`);
    return;
  }

  // Stuck detector (fix #6): two fix-complaints in a row → switch strategy
  const isFixComplaint = FIX_WORDS.test(prompt) && state.versions.length > 0;
  if (isFixComplaint && state.lastWasFixRequest) state.fixFailStreak++;
  else state.fixFailStreak = isFixComplaint ? 1 : 0;
  state.lastWasFixRequest = isFixComplaint;
  const strategy = state.fixFailStreak >= 2 ? "rethink" : null;
  $("stuckBanner").hidden = strategy !== "rethink";

  addMsg("user", esc(prompt));
  $("promptInput").value = "";
  $("estimate").textContent = "est. —";
  const workingMsg = addMsg("assistant working", "Building…");
  setBusy(true);

  try {
    const managedHeaders = await managed.headers();
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-anthropic-key": state.apiKey, ...managedHeaders },
      body: JSON.stringify({ prompt, currentCode: currentCode(), strategy }),
    });
    if (!r.ok && !r.headers.get("content-type")?.includes("event-stream")) {
      const errBody = await r.json();
      if (errBody.capReached) {
        // Managed-plan cap: this is a pause, not a failure — say so plainly, no bill-shock framing.
        workingMsg.remove();
        addMsg("system", `⏸ ${esc(errBody.error)}`);
        return;
      }
      throw new Error(errBody.error || "Request failed (" + r.status + ")");
    }

    const result = await readSSE(r, (partial) => {
      workingMsg.textContent = "Building… " + partial.length.toLocaleString() + " chars";
    });
    if (result.type === "error") throw new Error(result.message);

    const { code, note } = extractCode(result.text);
    if (!code) {
      // Failed generation → wasted, NOT build spend (fix #1)
      state.wasted += result.cost || 0;
      renderMeter();
      workingMsg.className = "msg assistant failed";
      workingMsg.innerHTML =
        "⚠ Generation failed — the model didn't return a valid app." +
        `<span class="cost-line">cost ${fmt$(result.cost || 0)} — marked as failed, NOT counted in build spend</span>`;
      return;
    }

    // Success
    state.spend += result.cost || 0;
    const version = {
      id: state.versions.length + 1,
      time: new Date().toLocaleTimeString(),
      prompt,
      code,
      cost: result.cost || 0,
      note: note || "Updated the app.",
    };
    state.versions.push(version);
    state.currentVersion = state.versions.length - 1;
    state.fixFailStreak = 0;
    $("stuckBanner").hidden = true;

    workingMsg.className = "msg assistant";
    workingMsg.innerHTML =
      esc(version.note) +
      `<span class="cost-line">v${version.id} · ${fmt$(version.cost)} · ${result.usage.output_tokens.toLocaleString()} tokens out</span>`;

    renderAll();
  } catch (err) {
    workingMsg.className = "msg assistant failed";
    workingMsg.innerHTML = "⚠ " + esc(err.message) + `<span class="cost-line">no charge counted for failed request</span>`;
  } finally {
    setBusy(false);
    renderMeter();
    saveProject();
  }
});

/* ---------------- new project ---------------- */
$("newProjectBtn").addEventListener("click", () => {
  if (state.versions.length && !confirm("Start a new project? Current chat, versions and spend meter will be cleared. (Download your app first if you want to keep it.)")) return;
  localStorage.removeItem(PROJECT_KEY);
  location.reload();
});

function setBusy(b) {
  state.busy = b;
  $("sendBtn").disabled = b;
  $("sendBtn").textContent = b ? "Building…" : state.versions.length ? "Make the change" : "Build it";
}

async function readSSE(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finalEvent = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "text") { text += evt.t; onProgress(text); }
      else finalEvent = evt;
    }
  }
  return finalEvent || { type: "error", message: "Stream ended unexpectedly." };
}

function extractCode(text) {
  const fence = text.match(/```html\s*\n([\s\S]*?)```/);
  let code = fence ? fence[1].trim() : null;
  if (!code) {
    const doc = text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
    if (doc) code = doc[0];
  }
  if (code && !/<html[\s>]/i.test(code)) code = null;
  const note = text.split("```")[0].trim().split("\n")[0];
  return { code, note };
}

/* ---------------- render: preview / code / versions / security ---------------- */
function renderAll() {
  const code = currentCode();
  // preview
  $("previewEmpty").style.display = code ? "none" : "";
  $("previewFrame").hidden = !code;
  if (code) $("previewFrame").srcdoc = code;
  // code
  $("codeView").textContent = code || "No code yet.";
  renderVersions();
  runSecurityScan(code);
  renderLaunchCheck();
  renderBuildHealth();
  renderPublish();
}

/* ---------------- publish (security-gated) ---------------- */
function renderPublish() {
  $("publishBtn").disabled = !currentCode() || state.busy;
  $("publishBtn").textContent = state.publishId ? "🚀 Republish" : "🚀 Publish";
  const urlEl = $("publishUrl");
  if (state.publishId) {
    const url = location.origin + "/p/" + state.publishId;
    urlEl.innerHTML = `live at <a href="${url}" target="_blank" rel="noopener">${url}</a>`;
  } else {
    urlEl.textContent = "";
  }
}

$("publishBtn").addEventListener("click", async () => {
  const code = currentCode();
  if (!code) return;
  // Nudge, not a gate — headless-browser checks can be flaky, so this never blocks publishing.
  if (!(state.launchCheck && state.launchCheck.forVersion === state.currentVersion)) {
    addMsg("system", `💡 Tip: you haven't run a <b>Launch Check</b> on this version yet — it opens your app in a real browser and catches crashes a static scan can't. Publishing anyway.`);
  }
  // Security gate: critical findings block publishing entirely.
  const findings = scanCode(code);
  const critical = findings.filter((f) => f.severity === "bad");
  if (critical.length) {
    addMsg("system", `🛑 Publish blocked — the security scan found ${critical.length} critical issue${critical.length > 1 ? "s" : ""}: ${critical.map((f) => f.label.replace(/^No /, "")).join("; ")}. Open the <b>Security</b> tab, then ask me to fix them.`);
    return;
  }
  if (findings.length) {
    addMsg("system", `⚠ Publishing with ${findings.length} warning${findings.length > 1 ? "s" : ""} — check the <b>Security</b> tab to review.`);
  }
  try {
    const r = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, id: state.publishId }),
    });
    const data = await r.json();
    if (!r.ok) {
      const detail = data.blockers ? " (" + data.blockers.join("; ") + ")" : "";
      throw new Error((data.error || "Publish failed") + detail);
    }
    state.publishId = data.id;
    const url = location.origin + data.url;
    addMsg("system", `🚀 Published! Your app is live: <a href="${url}" target="_blank" rel="noopener">${url}</a> — share the link. Visitors can add it to their home screen like an app, and it'll work offline. Republish any time to update it.`);
    renderPublish();
    saveProject();
  } catch (err) {
    addMsg("system", `🛑 ${esc(err.message)}`);
  }
});

$("copyBtn").addEventListener("click", () => navigator.clipboard.writeText(currentCode()));

// Mirrors lib/pwa.js's server-side injectPWATags (minus the service-worker
// registration — a downloaded file has no network requests to cache offline,
// it's already fully local). Runs on a copy at download time only; the stored
// version/diff history stays exactly what the model generated.
const PWA_ICON_HREF =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a0d11'/%3E%3Cpath d='M32 10 L50 32 L32 54 L14 32 Z' fill='%2335d99a'/%3E%3C/svg%3E";
function addPWATags(html) {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const name = (titleMatch ? titleMatch[1].trim() : "") || "My App";
  const manifest = {
    name: name.slice(0, 45),
    short_name: name.length > 14 ? name.slice(0, 14) : name,
    start_url: ".",
    display: "standalone",
    background_color: "#0a0d11",
    theme_color: "#35d99a",
    icons: [{ src: PWA_ICON_HREF, sizes: "512x512", type: "image/svg+xml", purpose: "any" }],
  };
  const manifestHref = "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifest));
  let tags =
    `<meta name="mobile-web-app-capable" content="yes">\n` +
    `<meta name="apple-mobile-web-app-capable" content="yes">\n` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n` +
    `<link rel="apple-touch-icon" href="${PWA_ICON_HREF}">\n` +
    `<link rel="manifest" href="${manifestHref}">`;
  if (!/<meta[^>]*name=["']viewport["']/i.test(html)) {
    tags = `<meta name="viewport" content="width=device-width, initial-scale=1">\n` + tags;
  }
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + "\n" + tags) : tags + "\n" + html;
}

$("downloadBtn").addEventListener("click", () => {
  const blob = new Blob([addPWATags(currentCode())], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "my-app.html";
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------------- versions + diff (fix #2) ---------------- */
function renderVersions() {
  const list = $("versionList");
  list.innerHTML = "";
  [...state.versions].reverse().forEach((v) => {
    const idx = v.id - 1;
    const li = document.createElement("li");
    li.className = "version-item" + (idx === state.currentVersion ? " current" : "");
    li.innerHTML =
      `<div class="v-title">v${v.id} — ${esc(v.prompt.slice(0, 48))}${v.prompt.length > 48 ? "…" : ""}</div>` +
      `<div class="v-meta">${v.time} · ${fmt$(v.cost)}</div>` +
      `<div class="v-actions"><button class="btn small" data-restore="${idx}">Restore</button></div>`;
    li.addEventListener("click", (e) => {
      if (e.target.dataset.restore !== undefined) return;
      document.querySelectorAll(".version-item").forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      renderDiff(idx);
    });
    li.querySelector("[data-restore]").addEventListener("click", () => {
      state.currentVersion = idx;
      addMsg("system", `⏪ Restored v${v.id}. Nothing lost — later versions stay in the list.`);
      renderAll();
      saveProject();
    });
    list.appendChild(li);
  });
}

function renderDiff(idx) {
  const view = $("diffView");
  const curr = state.versions[idx];
  const prev = idx > 0 ? state.versions[idx - 1] : null;
  if (!prev) {
    view.innerHTML = `<div class="diff-summary">v1 is the first version — nothing to compare.</div>`;
    return;
  }
  const a = prev.code.split("\n");
  const b = curr.code.split("\n");
  if (a.length > 2000 || b.length > 2000) {
    view.innerHTML = `<div class="diff-summary">File too large for line diff (${b.length} lines).</div>`;
    return;
  }
  const ops = lineDiff(a, b);
  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  let html = `<div class="diff-summary">v${prev.id} → v${curr.id}: <b>+${added}</b> lines added, <b>−${removed}</b> removed (of ${b.length}). Small, targeted diffs are good — huge diffs mean the AI rewrote things it shouldn't have.</div>`;
  let ctxSkip = 0;
  ops.forEach((op, i) => {
    if (op.t === " ") {
      const nearChange =
        ops.slice(Math.max(0, i - 2), i + 3).some((o) => o.t !== " ");
      if (!nearChange) { ctxSkip++; return; }
      if (ctxSkip > 0) { html += `<div class="diff-gap">⋯ ${ctxSkip} unchanged lines ⋯</div>`; ctxSkip = 0; }
      html += `<div class="diff-line ctx"> ${esc(op.s)}</div>`;
    } else {
      if (ctxSkip > 0) { html += `<div class="diff-gap">⋯ ${ctxSkip} unchanged lines ⋯</div>`; ctxSkip = 0; }
      html += `<div class="diff-line ${op.t === "+" ? "add" : "del"}">${op.t}${esc(op.s)}</div>`;
    }
  });
  if (ctxSkip > 0) html += `<div class="diff-gap">⋯ ${ctxSkip} unchanged lines ⋯</div>`;
  view.innerHTML = html;
}

// simple LCS-based line diff
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", s: a[i] }); i++; }
    else { ops.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });
  return ops;
}

/* ---------------- security scan (fix #4) ---------------- */
const SEC_CHECKS = [
  {
    label: "No hardcoded API keys or secrets",
    severity: "bad",
    re: /(sk-[a-zA-Z0-9_-]{18,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ghp_[a-zA-Z0-9]{30,}|(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-\/+]{16,}["'])/i,
    advice: "A credential appears to be baked into the code. Anyone who opens your app can steal it. Ask VibeSafe Builder to make the app request the key from the user at runtime instead.",
  },
  {
    label: "No eval() or dynamic code execution",
    severity: "bad",
    re: /\beval\s*\(|new\s+Function\s*\(/,
    advice: "eval() lets injected text run as code. Ask VibeSafe Builder to remove it.",
  },
  {
    label: "No insecure http:// resources",
    severity: "warn",
    re: /(src|href)\s*=\s*["']http:\/\//i,
    advice: "Resources loaded over plain http can be tampered with. Ask VibeSafe Builder to switch them to https.",
  },
  {
    label: "No passwords stored in localStorage",
    severity: "bad",
    re: /localStorage\.(setItem\s*\(\s*["'][^"']*(password|passwd|secret)|[a-zA-Z_]*(password|passwd|secret))/i,
    advice: "Passwords should never persist in localStorage. Ask VibeSafe Builder for a safer approach.",
  },
  {
    label: "No reading VibeSafe Builder's own storage keys",
    severity: "bad",
    re: /vc_apiKey|vc_project\b|vc_cap\b|sb-[\w-]+-auth-token|supabase\.auth\.(token|session)/i,
    advice: "Published apps run on the same domain as the builder, so this pattern can read another visitor's API key or session from shared browser storage. This is blocked from publishing — ask VibeSafe Builder to remove it.",
  },
  {
    label: "No data sent to unknown third-party servers",
    severity: "warn",
    re: /(fetch|XMLHttpRequest|axios|\.post)\s*\(\s*["']https?:\/\/(?!(cdn\.|unpkg\.com|cdnjs\.|jsdelivr\.net|fonts\.googleapis|fonts\.gstatic))/i,
    advice: "The app talks to an external server. Make sure that's an integration you asked for and that no personal data is sent without consent.",
  },
];

function scanCode(code) {
  return SEC_CHECKS.filter((c) => c.re.test(code));
}

function runSecurityScan(code) {
  const report = $("securityReport");
  const badge = $("secBadge");
  if (!code) {
    report.innerHTML = `<div class="empty">Generate an app to run the security scan.</div>`;
    badge.hidden = true;
    return;
  }
  let failures = 0;
  let html = "";
  for (const check of SEC_CHECKS) {
    const hit = check.re.exec(code);
    if (hit) {
      failures++;
      html += `<div class="sec-item ${check.severity}">✗ ${check.label}
        <div class="sec-advice">${check.advice}<br>Found: <code>${esc(hit[0].slice(0, 80))}</code></div></div>`;
    } else {
      html += `<div class="sec-item ok">✓ ${check.label}</div>`;
    }
  }
  const verdict = failures === 0
    ? `<div class="sec-verdict pass">✓ Scan passed — safe to share this app</div>`
    : `<div class="sec-verdict fail">✗ ${failures} issue${failures > 1 ? "s" : ""} found — fix before sharing</div>`;
  report.innerHTML = verdict + html +
    `<div class="sec-item"><b>Also enforced at generation time:</b>
     <div class="sec-advice">VibeSafe Builder's system prompt forbids hardcoded secrets, tracking, eval(), and silent data exfiltration — this scan is the second line of defense, not the only one.</div></div>`;
  badge.hidden = false;
  badge.textContent = failures === 0 ? "✓" : String(failures);
  badge.className = "sec-badge " + (failures === 0 ? "pass" : "fail");
}

/* ---------------- launch check (real headless-browser validation) ---------------- */
$("launchCheckBtn").addEventListener("click", runLaunchCheck);

async function runLaunchCheck() {
  const code = currentCode();
  if (!code) return;
  const btn = $("launchCheckBtn");
  const statusEl = $("lcStatus");
  const report = $("launchCheckReport");
  btn.disabled = true;
  statusEl.textContent = "Loading your app in a real browser… (~10–20s)";
  report.innerHTML = `<div class="empty">Checking for console errors, crashes, and mobile layout breaks…</div>`;
  try {
    const r = await fetch("/api/launch-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Launch Check failed");
    state.launchCheck = { forVersion: state.currentVersion, result: data };
    statusEl.textContent = "";
    renderLaunchCheck();
    renderBuildHealth();
  } catch (err) {
    statusEl.textContent = "";
    report.innerHTML = `<div class="sec-item bad">✗ Launch Check failed<div class="sec-advice">${esc(err.message)} — this is a live browser check and can occasionally time out; try again.</div></div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderLaunchCheck() {
  const badge = $("lcBadge");
  const report = $("launchCheckReport");
  const lc = state.launchCheck;
  if (!lc || lc.forVersion !== state.currentVersion || !lc.result) {
    report.innerHTML = `<div class="empty">Run a Launch Check to load your app in a real browser and catch what a static scan can't — console errors, crashes, and mobile layout breaks.</div>`;
    badge.hidden = true;
    return;
  }
  const { score, findings, screenshotDesktop, screenshotMobile } = lc.result;
  const verdict = score >= 90
    ? `<div class="sec-verdict pass">✓ Launch score ${score}/100 — looks solid</div>`
    : `<div class="sec-verdict fail">✗ Launch score ${score}/100 — issues found</div>`;
  const findingsHtml = findings.length
    ? findings.map((f) => `<div class="sec-item ${f.severity === "bad" ? "bad" : "warn"}">✗ ${esc(f.label)}<div class="sec-advice">${esc(f.detail)}</div></div>`).join("")
    : `<div class="sec-item ok">✓ No console errors, crashes, or mobile overflow detected</div>`;
  const shots = `
    <div class="lc-shots">
      <div class="lc-shot"><div class="lc-shot-label">Desktop</div><img src="${screenshotDesktop}" alt="Desktop screenshot of the app" /></div>
      <div class="lc-shot"><div class="lc-shot-label">Mobile (375px)</div><img src="${screenshotMobile}" alt="Mobile screenshot of the app" /></div>
    </div>`;
  report.innerHTML = verdict + findingsHtml + shots;
  badge.hidden = false;
  badge.textContent = String(score);
  badge.className = "sec-badge " + (score >= 90 ? "pass" : "fail");
}

/* ---------------- build health (combines the security scan + Launch Check into one view) ---------------- */
function renderBuildHealth() {
  const report = $("healthReport");
  const badge = $("healthBadge");
  const code = currentCode();
  if (!code) {
    report.innerHTML = `<div class="empty">Generate an app to see its Build Health.</div>`;
    badge.hidden = true;
    return;
  }

  const failedChecks = scanCode(code);
  const totalChecks = SEC_CHECKS.length;
  const criticalSec = failedChecks.filter((f) => f.severity === "bad").length;
  const warnSec = failedChecks.filter((f) => f.severity === "warn").length;
  const secOk = failedChecks.length === 0;

  const lc = state.launchCheck && state.launchCheck.forVersion === state.currentVersion ? state.launchCheck.result : null;

  const rows = [
    {
      icon: secOk ? "🟢" : criticalSec ? "🔴" : "🟡",
      title: "Security",
      detail: secOk
        ? `${totalChecks}/${totalChecks} checks passed`
        : `${totalChecks - failedChecks.length}/${totalChecks} checks passed — ${criticalSec} critical, ${warnSec} warning`,
    },
  ];

  if (lc) {
    const overflow = lc.findings.find((f) => f.label === "Mobile overflow");
    const runtimeIssues = lc.findings.filter((f) => f.label !== "Mobile overflow");
    rows.push({
      icon: runtimeIssues.length === 0 ? "🟢" : "🔴",
      title: "Runtime (real browser)",
      detail: runtimeIssues.length === 0 ? "No console errors or crashes detected" : `${runtimeIssues.length} issue${runtimeIssues.length > 1 ? "s" : ""} found — see Launch Check tab`,
    });
    rows.push({
      icon: overflow ? "🟡" : "🟢",
      title: "Mobile layout",
      detail: overflow ? overflow.detail : "No overflow detected at a 375px viewport",
    });
  } else {
    rows.push({
      icon: "⚪",
      title: "Runtime & mobile layout",
      detail: "Not checked yet — Launch Check loads your app in a real browser to catch what a static scan can't.",
      action: `<button type="button" class="btn small" id="healthRunLC">Run Launch Check</button>`,
    });
  }

  const anyCritical = criticalSec > 0 || (lc && lc.findings.some((f) => f.severity === "bad"));
  const anyWarn = !anyCritical && (warnSec > 0 || (lc && lc.findings.length > 0));
  const overallClass = anyCritical ? "bad" : anyWarn || !lc ? "warn" : "good";
  const overallText = anyCritical
    ? "🔴 Issues found — review before sharing"
    : !lc
    ? "🟡 Security looks good — run Launch Check for the full picture"
    : anyWarn
    ? "🟡 Mostly good — a few things worth a look"
    : "🟢 All checks passed";

  const rowsHtml = rows
    .map(
      (r) => `<div class="health-row">
        <span class="h-icon">${r.icon}</span>
        <div class="h-body">
          <div class="h-title">${esc(r.title)}</div>
          <div class="h-detail">${esc(r.detail)}</div>
          ${r.action ? `<div class="h-action">${r.action}</div>` : ""}
        </div>
      </div>`
    )
    .join("");

  report.innerHTML =
    `<div class="health-overall ${overallClass}">${overallText}</div>` +
    rowsHtml +
    `<div class="health-note">Single-file apps have no dependency tree — that's a whole category of risk (outdated or vulnerable packages) this build simply doesn't carry.</div>`;

  $("healthRunLC")?.addEventListener("click", runLaunchCheck);

  badge.hidden = false;
  badge.textContent = anyCritical ? "!" : !lc ? "…" : "✓";
  badge.className = "sec-badge " + (anyCritical ? "fail" : lc && !anyWarn ? "pass" : "");
}

/* ---------------- templates gallery ---------------- */
function renderTemplateGrid() {
  const grid = $("templateGrid");
  if (!grid || !window.TEMPLATES) return;
  grid.innerHTML = window.TEMPLATES.map((t, i) =>
    `<div class="template-card">
       <button type="button" class="t-main" data-t="${i}">
         <div class="t-icon">${t.icon}</div>
         <div class="t-name">${esc(t.name)}</div>
         <div class="t-desc">${esc(t.desc)}</div>
       </button>
       ${t.prompt ? `<button type="button" class="t-use-prompt" data-use-prompt="${i}">✏️ Use as prompt</button>` : ""}
     </div>`
  ).join("");
  grid.addEventListener("click", (e) => {
    const promptBtn = e.target.closest("[data-use-prompt]");
    if (promptBtn) { usePromptFromTemplate(window.TEMPLATES[+promptBtn.dataset.usePrompt]); return; }
    const card = e.target.closest("[data-t]");
    if (!card) return;
    useTemplate(window.TEMPLATES[+card.dataset.t]);
  });
}

// "Inspiration" path: instead of loading the free static file, drop the
// template's real prompt into the composer so the user can edit it and get
// an AI-generated (paid) version tailored to them — the free template stays
// one click away on the same card for anyone who just wants the instant version.
function usePromptFromTemplate(t) {
  const input = $("promptInput");
  input.value = t.prompt;
  input.dispatchEvent(new Event("input", { bubbles: true })); // reuses the existing debounced cost-estimate listener
  input.focus();
  addMsg("system", `✏️ Filled in the prompt for <b>${esc(t.name)}</b> below — edit it to make it yours, then hit <b>Build it</b>. (Or clear it and write your own.)`);
}

function useTemplate(t) {
  const version = {
    id: state.versions.length + 1,
    time: new Date().toLocaleTimeString(),
    prompt: "Start from template: " + t.name,
    code: t.code,
    cost: 0,
    note: `Loaded the "${t.name}" template — free, zero tokens spent. Ask for changes any time.`,
  };
  state.versions.push(version);
  state.currentVersion = state.versions.length - 1;
  state.fixFailStreak = 0;
  addMsg("user", `${t.icon} Start from template: ${esc(t.name)}`);
  addMsg("assistant", esc(version.note) + `<span class="cost-line">v${version.id} · $0.00 (template) · 0 tokens</span>`);
  renderAll();
  saveProject();
}

/* ---------------- init ---------------- */
// loadProject() runs first: if it restores a saved chat, it overwrites
// #messages.innerHTML wholesale (see loadProject below), which would wipe out
// the listener renderTemplateGrid() attaches to #templateGrid if that ran
// first. Rendering the grid after restore means it (re)builds into whatever
// #templateGrid element currently exists and attaches a fresh listener to it.
const restored = loadProject();
renderTemplateGrid();
renderMeter();
if (restored) {
  renderAll();
  addMsg("system", `📂 Project restored — v${state.versions[state.currentVersion].id} of ${state.versions.length} version${state.versions.length > 1 ? "s" : ""}, ${fmt$(state.spend)} spent. Pick up where you left off.`);
} else if (!state.apiKey) {
  addMsg("system", `🔑 First run: add your Anthropic API key in <b>Settings</b> (top right). It stays in this browser and is only used to call the Claude API from your own machine.`);
}
