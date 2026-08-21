/* Show/hide toggle for every password field on the page.
   Written as a self-contained enhancer rather than markup baked into each field:
   there are five password inputs across two pages (auth gate, confirm password,
   Anthropic key, Vercel token, admin key) sitting in three different layouts, and
   any new one should get this for free. Injects its own CSS so it works on
   admin.html too, which has no external stylesheet. */
(function () {
  "use strict";

  var STYLE_ID = "pw-toggle-style";

  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".pw-wrap { position: relative; display: block; }",
      /* The Vercel-token field lives in a flex row and carried its own min-width;
         the wrapper becomes the flex child, so it inherits that job. */
      ".gh-row .pw-wrap { flex: 1 1 260px; }",
      ".pw-wrap > input { width: 100%; padding-right: 42px; }",
      ".pw-eye {",
      "  position: absolute; right: 0; width: 38px;",
      "  display: flex; align-items: center; justify-content: center;",
      "  margin: 0; padding: 0; border: 0; background: none; cursor: pointer;",
      "  color: var(--text-dim, #8d9aa8); line-height: 0;",
      "}",
      ".pw-eye:hover { color: var(--text, #eef3f7); }",
      ".pw-eye:focus-visible { outline: 2px solid var(--accent, #35d99a); outline-offset: -2px; border-radius: 6px; }",
      ".pw-eye svg { width: 17px; height: 17px; display: block; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function setState(input, btn, reveal) {
    input.type = reveal ? "text" : "password";
    btn.innerHTML = reveal ? EYE_OFF : EYE;
    btn.setAttribute("aria-pressed", reveal ? "true" : "false");
    var label = reveal ? "Hide password" : "Show password";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }

  function enhance(input) {
    if (input.dataset.pwToggle === "done") return;
    input.dataset.pwToggle = "done";

    var wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement("button");
    btn.className = "pw-eye";
    // type=button matters: several of these inputs sit inside a <form>, and the
    // default submit type would submit it on every reveal.
    btn.type = "button";
    // Never let the reveal button steal focus-order from the field it belongs to.
    btn.tabIndex = -1;
    setState(input, btn, false);
    wrap.appendChild(btn);

    // The eye sits over the input, not over the label text above it, so it is
    // aligned to the input box itself rather than the whole wrapper.
    function align() {
      btn.style.top = input.offsetTop + "px";
      btn.style.height = input.offsetHeight + "px";
    }
    align();
    if (window.ResizeObserver) new ResizeObserver(align).observe(input);

    btn.addEventListener("click", function () {
      setState(input, btn, input.type === "password");
      input.focus();
    });
  }

  function enhanceAll() {
    injectStyles();
    var inputs = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) enhance(inputs[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceAll);
  } else {
    enhanceAll();
  }
})();
