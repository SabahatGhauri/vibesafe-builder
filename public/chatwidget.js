/* VibeSafe Builder — lightweight FAQ chat widget.
   Self-contained (scoped styles + no external calls): answers common questions from a
   canned knowledge base built from the actual product (pricing, modes, security scan,
   versions, publishing). No AI backend — "Powered by AI" is deliberately not claimed here. */
(function () {
  const KB = [
    {
      q: "What does it do?",
      keys: ["what does it do", "what is this", "what is vibesafe builder", "what do you do"],
      a: "You describe an app in chat and VibeSafe Builder generates a complete, single-file web app. You see the cost before every generation, every change is a version you can roll back, and every build is security-scanned before you publish it. See <a href=\"/how-it-works.html\">how it works</a>.",
    },
    {
      q: "Pricing?",
      keys: ["pricing", "price", "cost", "how much", "plans"],
      a: "Two options: <strong>Bring Your Own Key</strong> — $0 platform fee, you pay Anthropic directly at their standard rates. Or the <strong>Managed plan</strong> — $15/month, no API key needed, we cover up to $10/month of usage. Full breakdown on the <a href=\"/#pricing\">pricing section</a>.",
    },
    {
      q: "Is my code safe?",
      keys: ["safe", "security", "secure", "leak", "exposed", "key stored"],
      a: "In BYOK mode your API key and project live only in your browser's localStorage — we never store your key. Every generated app is scanned for hardcoded secrets and unsafe patterns before you can publish it. Details in the <a href=\"/legal.html\">Legal &amp; Privacy</a> page.",
    },
    {
      q: "Get started",
      keys: ["get started", "start building", "sign up", "begin", "how do i start"],
      a: "Click <a href=\"/app\">Open the builder</a>, describe the app you want (or pick a free template), and hit Build it. No account needed for Bring Your Own Key mode. Full walkthrough in the <a href=\"/user-guide.html\">User Guide</a>.",
    },
    {
      q: "Can I roll back a change?",
      keys: ["rollback", "roll back", "undo", "version", "revert"],
      a: "Yes — every successful generation is saved as a version with a diff against the last one. Open the Versions tab in the builder and click Restore on any earlier version.",
    },
    {
      q: "Can I download my app?",
      keys: ["download", "own my", "lock-in", "lock in", "export", "portable"],
      a: "Yes. The Code tab has a Download .html button — your app is one portable file you can open locally, host anywhere, or hand to someone else.",
    },
    {
      q: "Who built this?",
      keys: ["who built", "who made", "parent company", "company", "about"],
      a: "VibeSafe Builder is built by SG Digital Ventures LLC, a Wyoming-based SaaS company also behind the code security scanner VibeSafe. More on the <a href=\"/about.html\">About page</a>.",
    },
  ];
  const FALLBACK =
    "I don't have a canned answer for that one. Try the <a href=\"/user-guide.html\">User Guide</a> or email <a href=\"mailto:contact@vibesafebuilder.com\">contact@vibesafebuilder.com</a>.";

  function match(text) {
    const t = text.toLowerCase();
    let best = null, bestScore = 0;
    for (const entry of KB) {
      for (const k of entry.keys) {
        if (t.includes(k) && k.length > bestScore) { best = entry; bestScore = k.length; }
      }
    }
    return best ? best.a : FALLBACK;
  }

  const css = `
    .vcw-fab { position: fixed; right: 22px; bottom: 22px; z-index: 999; width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #35d99a, #22b88a); border: none; cursor: pointer; font-size: 22px;
      box-shadow: 0 10px 30px -8px rgba(53,217,154,0.55); transition: transform 0.2s; }
    .vcw-fab:hover { transform: translateY(-2px) scale(1.04); }
    .vcw-panel { position: fixed; right: 22px; bottom: 86px; z-index: 999; width: 320px; max-width: calc(100vw - 44px);
      max-height: 440px; display: none; flex-direction: column; border-radius: 16px; overflow: hidden;
      background: #141a21; border: 1px solid #232b34; box-shadow: 0 30px 70px -20px rgba(0,0,0,0.65);
      font-family: "Segoe UI", system-ui, sans-serif; }
    .vcw-panel.open { display: flex; }
    .vcw-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: #0f1318; border-bottom: 1px solid #232b34; }
    .vcw-head .vcw-dot { width: 8px; height: 8px; border-radius: 50%; background: #35d99a; box-shadow: 0 0 8px #35d99a; }
    .vcw-head .vcw-title { font-weight: 700; font-size: 13.5px; color: #eef3f7; }
    .vcw-head .vcw-sub { font-size: 11px; color: #8d9aa8; margin-top: 1px; }
    .vcw-head-txt { flex: 1; }
    .vcw-close { background: none; border: none; color: #8d9aa8; cursor: pointer; font-size: 15px; padding: 4px; }
    .vcw-close:hover { color: #eef3f7; }
    .vcw-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .vcw-msg { font-size: 13px; line-height: 1.5; color: #eef3f7; background: #1d242c; border: 1px solid #232b34;
      border-radius: 10px; padding: 9px 11px; max-width: 92%; }
    .vcw-msg a { color: #4fc3ff; }
    .vcw-msg.user { align-self: flex-end; background: #1a3b30; border-color: #22b88a; }
    .vcw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .vcw-chip { background: #1d242c; border: 1px solid #232b34; color: #eef3f7; border-radius: 100px;
      padding: 6px 11px; font-size: 12px; cursor: pointer; }
    .vcw-chip:hover { border-color: #35d99a; color: #35d99a; }
    .vcw-foot { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #232b34; background: #0f1318; }
    .vcw-foot input { flex: 1; background: #1d242c; border: 1px solid #232b34; border-radius: 8px; color: #eef3f7;
      padding: 8px 10px; font-size: 12.5px; font-family: inherit; }
    .vcw-foot input:focus { outline: 1px solid #35d99a; }
    .vcw-foot button { background: #35d99a; border: none; color: #04180f; font-weight: 700; border-radius: 8px;
      padding: 0 12px; cursor: pointer; }
  `;

  function init() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const fab = document.createElement("button");
    fab.className = "vcw-fab";
    fab.setAttribute("aria-label", "Chat with VibeSafe Builder");
    fab.textContent = "💬";

    const panel = document.createElement("div");
    panel.className = "vcw-panel";
    panel.innerHTML = `
      <div class="vcw-head">
        <span class="vcw-dot"></span>
        <div class="vcw-head-txt">
          <div class="vcw-title">VibeSafe Builder Assistant</div>
          <div class="vcw-sub">Answers from the docs — instantly</div>
        </div>
        <button class="vcw-close" aria-label="Close">✕</button>
      </div>
      <div class="vcw-body" id="vcwBody">
        <div class="vcw-msg">Hi! Ask me about pricing, security, or how to get started — or pick a question below.</div>
        <div class="vcw-chips" id="vcwChips"></div>
      </div>
      <form class="vcw-foot" id="vcwForm">
        <input id="vcwInput" type="text" placeholder="Ask a question..." autocomplete="off" />
        <button type="submit">➤</button>
      </form>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const body = panel.querySelector("#vcwBody");
    const chips = panel.querySelector("#vcwChips");
    const form = panel.querySelector("#vcwForm");
    const input = panel.querySelector("#vcwInput");
    const close = panel.querySelector(".vcw-close");

    KB.slice(0, 4).forEach((entry) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vcw-chip";
      chip.textContent = entry.q;
      chip.addEventListener("click", () => ask(entry.q, entry.a));
      chips.appendChild(chip);
    });

    function addMsg(text, isUser) {
      const m = document.createElement("div");
      m.className = "vcw-msg" + (isUser ? " user" : "");
      m.innerHTML = text;
      body.appendChild(m);
      body.scrollTop = body.scrollHeight;
    }

    function ask(question, knownAnswer) {
      addMsg(question, true);
      setTimeout(() => addMsg(knownAnswer || match(question), false), 250);
    }

    fab.addEventListener("click", () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) input.focus();
    });
    close.addEventListener("click", () => panel.classList.remove("open"));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      ask(v);
      input.value = "";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
