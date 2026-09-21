// Customer-supplied images.
//
// The problem this shape solves: version history keeps every build's code, so
// embedding a 200KB image directly in the code would store a fresh copy per
// version and exhaust the browser's storage quota within a few builds. Images
// are therefore stored ONCE in a separate map, and the code carries a
// placeholder - {{image:hero}} - that is swapped for the real data only at the
// moment something needs to run: preview, publish, download, Launch Check.
//
// The model never sees image data either. A base64 image in the prompt would
// cost thousands of tokens per build and wreck the cost estimate, so the AI is
// told the placeholders exist and writes them into the markup itself.
//
// Shared by the browser and by lib/app.js (which rejects a publish still
// carrying a placeholder), so it is written to load in both.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.assets = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Slots are named rather than numbered so a prompt can say "use the hero
  // image" and the AI writes something meaningful into the markup.
  const SLOTS = ["hero", "logo", "background"];
  const MAX_ASSETS = 3;
  const MAX_BYTES = 300 * 1024; // after in-browser re-encoding
  const MAX_EDGE = 1600; // px on the longest side

  // SVG is deliberately absent: an SVG can carry <script>, and accepting one
  // would punch a hole straight through the security scan this product sells.
  const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  const PLACEHOLDER = /\{\{image:([a-z][a-z0-9_-]{0,23})\}\}/gi;

  function slotPlaceholder(slot) {
    return "{{image:" + slot + "}}";
  }

  // Returns null when the file is acceptable, or a message to show the user.
  // Checked before reading the file, so an obviously wrong pick fails fast.
  function rejectFile(file) {
    if (!file) return "No file selected.";
    if (!ALLOWED_TYPES.includes(file.type)) {
      return "That file type isn't supported. Use a PNG, JPEG, WebP or GIF — SVG isn't accepted because it can contain scripts.";
    }
    if (file.size > 12 * 1024 * 1024) return "That image is over 12MB. Pick a smaller one.";
    return null;
  }

  // A data URI we produced ourselves still gets checked before it is trusted:
  // the upload path is the one place a customer's bytes enter a published app.
  function isSafeDataUri(value) {
    return typeof value === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
  }

  function validSlot(slot) {
    return SLOTS.includes(slot);
  }

  // Swaps every {{image:slot}} for its data URI. An unknown or empty slot
  // resolves to a 1x1 transparent pixel rather than being left as literal text,
  // because a visible "{{image:hero}}" in a published app looks broken in a way
  // a missing image does not.
  const BLANK_PIXEL =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function substitute(code, assets) {
    if (typeof code !== "string" || !code) return code || "";
    const map = assets || {};
    return code.replace(PLACEHOLDER, function (_match, slot) {
      const value = map[String(slot).toLowerCase()];
      return isSafeDataUri(value) ? value : BLANK_PIXEL;
    });
  }

  // Which slots the current code actually references — drives the UI hint
  // "your app uses the hero slot" and the publish-time guard.
  function placeholdersUsed(code) {
    if (typeof code !== "string") return [];
    const found = [];
    let m;
    const re = new RegExp(PLACEHOLDER.source, "gi");
    while ((m = re.exec(code)) !== null) {
      const slot = m[1].toLowerCase();
      if (!found.includes(slot)) found.push(slot);
    }
    return found;
  }

  function hasPlaceholder(code) {
    return placeholdersUsed(code).length > 0;
  }

  // Rough byte cost of the images once embedded. Base64 inflates by ~4/3, and
  // published HTML is capped server-side, so the UI warns before a publish
  // fails rather than after.
  function embeddedBytes(assets) {
    return Object.values(assets || {}).reduce(function (sum, v) {
      return sum + (typeof v === "string" ? v.length : 0);
    }, 0);
  }

  return {
    SLOTS,
    MAX_ASSETS,
    MAX_BYTES,
    MAX_EDGE,
    ALLOWED_TYPES,
    BLANK_PIXEL,
    slotPlaceholder,
    rejectFile,
    isSafeDataUri,
    validSlot,
    substitute,
    placeholdersUsed,
    hasPlaceholder,
    embeddedBytes,
  };
});
