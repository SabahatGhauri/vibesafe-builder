"use strict";

/* ---------------- Phase 2B: visual editor ----------------
 * Click an element in the preview, change its properties, and the change is
 * written back into the JSX source file it came from — not into a parallel
 * style store that would drift from the code.
 *
 * The mapping comes from data-vs-loc, stamped onto every host element by the
 * runtime in lib/multifile.js during the transform that already runs. Selection
 * and live feedback happen inside the iframe; the actual source surgery happens
 * server-side (/api/visual-edit) so there is exactly one implementation of it.
 *
 * Only meaningful for multi-file projects — single-file apps have no file tree
 * to edit, so the toggle stays hidden for them.
 */

const ve = {
  on: false,
  selected: null, // { loc, tag, text, editableText, computed }
  // Undo/redo over whole file-map snapshots. Snapshots rather than inverse
  // operations because an edit can rewrite arbitrary source text, and replaying
  // that backwards correctly is far more error-prone than just keeping copies —
  // projects here are small enough that the memory cost is irrelevant.
  history: [],
  index: -1,
  pending: null,

  init() {
    window.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.__vibesafe === "selected") this.onSelected(d.element);
      if (d.__vibesafe === "runtime-error") this.status("The preview failed to run — fix the error before editing.", "error");
    });

    $("visualEditBtn")?.addEventListener("click", () => this.toggle());
    $("propsClose")?.addEventListener("click", () => this.toggle(false));
    $("veUndo")?.addEventListener("click", () => this.undo());
    $("veRedo")?.addEventListener("click", () => this.redo());

    // Live-preview on input, commit to source on change. That split keeps
    // dragging a slider feeling instant without firing a source rewrite per pixel.
    this.bindStyle("veColor", "color", (v) => v);
    this.bindStyle("veBg", "backgroundColor", (v) => v);
    this.bindStyle("veFontSize", "fontSize", (v) => v + "px", (v) => {
      const el = $("veFontSizeVal");
      if (el) el.textContent = v + "px";
    });
    this.bindStyle("veFontWeight", "fontWeight", (v) => v);
    this.bindStyle("veAlign", "textAlign", (v) => v);
    this.bindStyle("vePadding", "padding", (v) => v);
    this.bindStyle("veMargin", "margin", (v) => v);
    this.bindStyle("veRadius", "borderRadius", (v) => v);

    const textInput = $("veText");
    textInput?.addEventListener("input", () => this.post({ action: "preview-text", text: textInput.value }));
    textInput?.addEventListener("change", () => this.commit({ text: textInput.value }));
  },

  bindStyle(id, prop, format, onInput) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      if (!el.value) return;
      const v = format(el.value);
      if (onInput) onInput(el.value);
      this.post({ action: "preview-style", styles: { [prop]: v } });
    });
    el.addEventListener("change", () => {
      if (!el.value) return;
      this.commit({ styles: { [prop]: format(el.value) } });
    });
  },

  post(msg) {
    const frame = $("previewFrame");
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ __vibesafe: "editor", ...msg }, "*");
  },

  // Shown only for multi-file projects, and only once there's something to edit.
  refreshAvailability() {
    const btn = $("visualEditBtn");
    if (!btn) return;
    const available = isMulti() && currentFilePaths().length > 0;
    btn.hidden = !available;
    if (!available && this.on) this.toggle(false);
  },

  toggle(force) {
    this.on = typeof force === "boolean" ? force : !this.on;
    $("visualEditBtn")?.classList.toggle("on", this.on);
    $("propsPanel").hidden = !this.on;
    this.post({ action: "enable", on: this.on });
    if (!this.on) {
      this.selected = null;
    } else if (!this.history.length) {
      // Snapshot the starting point so the first undo has somewhere to go back to.
      this.history = [currentFiles()];
      this.index = 0;
      this.renderHistory();
      this.status("Click any element in the preview to edit it.");
    }
  },

  onSelected(el) {
    this.selected = el;
    $("propsTitle").textContent = "<" + el.tag + ">";
    $("propsSrc").textContent = (el.loc || "").replace(/^\//, "");
    $("propsTextField").hidden = !el.editableText;
    if (el.editableText) $("veText").value = el.text || "";

    const c = el.computed || {};
    $("veColor").value = toHex(c.color) || "#000000";
    $("veBg").value = toHex(c.backgroundColor) || "#ffffff";
    const size = parseInt(c.fontSize, 10) || 16;
    $("veFontSize").value = size;
    $("veFontSizeVal").textContent = size + "px";
    $("veFontWeight").value = ["300", "400", "600", "700", "800"].includes(String(parseInt(c.fontWeight, 10)))
      ? String(parseInt(c.fontWeight, 10))
      : "";
    $("veAlign").value = ["left", "center", "right"].includes(c.textAlign) ? c.textAlign : "";
    $("vePadding").value = "";
    $("veMargin").value = "";
    $("veRadius").value = "";
    this.status("");
  },

  async commit(change) {
    if (!this.selected) return this.status("Select an element first.", "error");
    this.status("Saving…");
    try {
      const r = await fetch("/api/visual-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: currentFiles(), loc: this.selected.loc, ...change }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not apply that change");

      this.pushHistory(data.files);
      await this.applyFiles(data.files, data.html);
      this.status("Saved to " + (this.selected.loc || "").replace(/^\//, "").split(":")[0], "ok");
    } catch (err) {
      // The live preview already moved; reassemble from the real source so what
      // is shown matches what is actually saved.
      this.status(err.message, "error");
      const html = await assembleCurrent();
      $("previewFrame").srcdoc = html;
      this.reenableAfterReload();
    }
  },

  // Visual edits update the CURRENT version in place rather than pushing a new
  // one each time — otherwise nudging a slider would bury the version list. The
  // starting state is preserved as history[0], so undo still gets you back.
  async applyFiles(files, html) {
    if (state.currentVersion < 0) return;
    state.versions[state.currentVersion].files = files;
    state.versions[state.currentVersion].visuallyEdited = true;
    if (html) {
      $("previewFrame").srcdoc = html;
      this.reenableAfterReload();
    }
    if (state.activeFile) $("codeView").textContent = files[state.activeFile] || "";
    runSecurityScan(sourcesForScan());
    renderPublish();
    saveProject();
  },

  // The iframe reloads on every srcdoc change, which resets the bridge inside
  // it, so edit mode has to be switched back on once the new document is ready.
  reenableAfterReload() {
    const frame = $("previewFrame");
    if (!frame) return;
    frame.addEventListener("load", () => { if (this.on) this.post({ action: "enable", on: true }); }, { once: true });
  },

  pushHistory(files) {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(files);
    this.index = this.history.length - 1;
    this.renderHistory();
  },

  async undo() {
    if (this.index <= 0) return;
    this.index--;
    await this.restore();
  },

  async redo() {
    if (this.index >= this.history.length - 1) return;
    this.index++;
    await this.restore();
  },

  async restore() {
    const files = this.history[this.index];
    await this.applyFiles(files, null);
    const html = await assembleCurrent();
    $("previewFrame").srcdoc = html;
    this.reenableAfterReload();
    this.renderHistory();
    this.status(this.index === 0 ? "Back to the starting point." : "Reverted.", "ok");
  },

  renderHistory() {
    const u = $("veUndo"), r = $("veRedo");
    if (u) u.disabled = this.index <= 0;
    if (r) r.disabled = this.index >= this.history.length - 1;
  },

  status(msg, cls) {
    const el = $("propsStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "props-status" + (cls ? " " + cls : "");
  },
};

// Colour inputs need #rrggbb; getComputedStyle hands back rgb()/rgba().
function toHex(v) {
  if (!v) return null;
  if (v.startsWith("#")) return v;
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return "#" + [m[1], m[2], m[3]].map((n) => parseInt(n, 10).toString(16).padStart(2, "0")).join("");
}

// Top-level const in a classic script does NOT become a window property, and
// app.js guards its calls with window.ve — so publish it explicitly.
window.ve = ve;

ve.init();
