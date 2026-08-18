"use strict";

/* ---------------- Phase 2C: build status and error reporting ----------------
 * Generated projects run inside a sandboxed iframe with no allow-same-origin,
 * so when one fails to build the builder cannot see why — the error is trapped
 * on the other side of the origin boundary. The runtime in lib/multifile.js now
 * forwards each failure out over postMessage; this surfaces them, with the file
 * that caused them, and lets you click straight through to that source.
 *
 * Applies to multi-file projects, which are the ones with a build step at all.
 */

const build = {
  errors: [],
  ok: false,
  // Errors arriving after a rebuild belong to the NEW build; this guards against
  // a late error from the previous document landing in the fresh report.
  epoch: 0,

  init() {
    window.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.__vibesafe === "build-ok") this.onOk(d);
      if (d.__vibesafe === "build-error") this.onError(d);
      // The pre-2C message name, still emitted by older published bundles.
      if (d.__vibesafe === "runtime-error") this.onError({ phase: "runtime", message: d.message, file: null });
    });
    $("buildStatus")?.addEventListener("click", () => {
      const box = $("buildErrors");
      if (box && this.errors.length) box.hidden = !box.hidden;
    });
    $("sharePreviewBtn")?.addEventListener("click", () => this.sharePreview());
  },

  // Called by the builder just before it swaps in a new preview document.
  reset() {
    this.epoch++;
    this.errors = [];
    this.ok = false;
    this.render();
  },

  onOk() {
    this.ok = true;
    this.render();
  },

  onError(d) {
    // De-duplicate: React re-throws the same error during its retry render, so
    // an identical message would otherwise be listed two or three times.
    const key = (d.phase || "") + "|" + (d.message || "");
    if (this.errors.some((e) => e.key === key)) return;
    this.errors.push({ key, phase: d.phase || "runtime", message: d.message || "Unknown error", file: d.file || null });
    this.ok = false;
    this.render();
  },

  render() {
    const status = $("buildStatus");
    const box = $("buildErrors");
    if (!status || !box) return;

    if (!isMulti() || !currentFilePaths().length) {
      status.hidden = true;
      box.hidden = true;
      if ($("sharePreviewBtn")) $("sharePreviewBtn").hidden = true;
      return;
    }
    if ($("sharePreviewBtn")) $("sharePreviewBtn").hidden = false;

    status.hidden = false;
    if (this.errors.length) {
      status.className = "build-status fail";
      status.innerHTML =
        '<span class="dot"></span>' + this.errors.length + " build error" + (this.errors.length > 1 ? "s" : "");
      box.hidden = false;
      box.innerHTML = this.errors
        .map((e) => {
          const file = e.file
            ? '<button type="button" class="be-file" data-file="' + esc(e.file) + '">' + esc(e.file) + "</button>"
            : "";
          return (
            '<div class="be-item"><span class="be-phase">' +
            esc(e.phase) +
            "</span>" +
            file +
            '<span class="be-msg">' +
            esc(e.message) +
            "</span></div>"
          );
        })
        .join("");
      // Clicking the filename opens that source in the Code tab — the whole point
      // of forwarding the file along with the message.
      box.querySelectorAll(".be-file").forEach((btn) => {
        btn.addEventListener("click", () => {
          const f = btn.dataset.file;
          if (!currentFiles()[f]) return;
          state.activeFile = f;
          document.querySelector('[data-tab="code"]')?.click();
          $("codeView").textContent = currentFiles()[f];
          renderFileTree();
        });
      });
    } else if (this.ok) {
      status.className = "build-status ok";
      status.innerHTML = '<span class="dot"></span>Build OK';
      box.hidden = true;
      box.innerHTML = "";
    } else {
      status.className = "build-status";
      status.innerHTML = '<span class="dot"></span>Building…';
      box.hidden = true;
    }
  },

  // A shareable link to the current work-in-progress build, kept distinct from
  // Publish: this is for showing someone your progress, not for shipping.
  async sharePreview() {
    const status = $("buildStatus");
    try {
      if (status) {
        status.className = "build-status";
        status.innerHTML = '<span class="dot"></span>Creating preview…';
      }
      const r = await fetch("/api/preview-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: currentFiles(), id: state.previewId || null }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not create a preview link");
      state.previewId = data.id;
      saveProject();
      const url = location.origin + data.url;
      addMsg(
        "system",
        '🔗 <strong>Preview link ready:</strong> <a href="' +
          esc(url) +
          '" target="_blank" rel="noopener">' +
          esc(url) +
          "</a> — a snapshot of this build, safe to share while you keep working. Publishing is still separate."
      );
      this.render();
    } catch (err) {
      addMsg("system", "🛑 " + esc(err.message));
      this.render();
    }
  },
};

window.build = build;
build.init();
