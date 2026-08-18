// Turns a customer-chosen color palette into an instruction the generation
// prompt can use, and validates untrusted request-body input before any of it
// reaches text sent to the model.
//
// A separate, tested module rather than inline in lib/app.js — the validation
// here is the only thing standing between arbitrary request-body content and
// the prompt used for every generation. lib/app.js itself has no test coverage
// (it's mostly route wiring), so anything worth testing lives outside it,
// matching lib/deploy.js, lib/securityGate.js, and the rest.

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const KEYS = ["bg", "primary", "accent", "text"];

// Exactly four keys, exactly 6-digit hex. Any missing or malformed field
// rejects the WHOLE palette rather than partially applying it — our own UI
// only ever sends complete, valid palettes, so a partial/invalid one only
// happens from a malformed or hand-crafted request. The safe response is the
// same as "no palette was sent": fall back to the model choosing its own,
// never let bad input break generation.
function validatePalette(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const k of KEYS) {
    const v = input[k];
    if (typeof v !== "string" || !HEX_RE.test(v)) return null;
    out[k] = v.toLowerCase();
  }
  return out;
}

// Returns "" for no/invalid palette, so callers can unconditionally prepend
// this to a prompt with no branching.
function paletteInstruction(input) {
  const p = validatePalette(input);
  if (!p) return "";
  return (
    `COLOR PALETTE: use this exact palette throughout — background ${p.bg}, ` +
    `primary/buttons ${p.primary}, secondary accent ${p.accent}, main text ${p.text}. ` +
    `Apply it consistently across the whole UI (backgrounds, buttons, headers, highlights) ` +
    `rather than inventing a different palette.\n\n`
  );
}

module.exports = { validatePalette, paletteInstruction };
