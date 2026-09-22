// The App Spec: what this app is supposed to do.
//
// Every prompt-to-app builder has the same failure: each request extends what
// is there, nothing records what the app was FOR, and after twenty edits the
// thing that used to work has quietly stopped working. Version history tells
// you what the code was. It does not tell you what it was meant to be.
//
// The spec is that missing document. It rides in the build prompt, so the
// model is reminded of the rules on every edit rather than being asked to
// remember them, and the model reports back what it added or contradicted
// using SPEC+ / SPEC! lines in its reply. No second AI call, so this costs
// nothing per build beyond a few hundred tokens of context.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spec = api;
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_RULES = 12;
  const RULE_CHARS = 140;
  const PURPOSE_CHARS = 200;

  function emptySpec() {
    return { purpose: "", rules: [], updatedAt: null };
  }

  function cleanLine(text, max) {
    // Collapse whitespace and strip anything that would let a rule masquerade
    // as an instruction block when it is pasted into the prompt.
    return String(text == null ? "" : text)
      .replace(/[`\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function normalise(input) {
    const spec = emptySpec();
    if (!input || typeof input !== "object") return spec;
    spec.purpose = cleanLine(input.purpose, PURPOSE_CHARS);
    const seen = new Set();
    for (const rule of Array.isArray(input.rules) ? input.rules : []) {
      const text = cleanLine(typeof rule === "string" ? rule : rule && rule.text, RULE_CHARS);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      spec.rules.push({ text });
      if (spec.rules.length >= MAX_RULES) break;
    }
    spec.updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : null;
    return spec;
  }

  function isEmpty(spec) {
    const s = normalise(spec);
    return !s.purpose && s.rules.length === 0;
  }

  // What goes into the build prompt. Bounded on purpose: the spec must never
  // grow until it crowds out the user's actual request.
  function promptBlock(spec) {
    const s = normalise(spec);
    if (isEmpty(s)) return "";
    let out = "THIS APP'S SPEC — what it is for, and what must stay true:\n";
    if (s.purpose) out += `Purpose: ${s.purpose}\n`;
    if (s.rules.length) {
      out += "Must stay true:\n" + s.rules.map((r) => `- ${r.text}`).join("\n") + "\n";
    }
    out +=
      "Honour every line above while making the change. If the request would break one, " +
      "say so in your reply on a line starting SPEC! and describe the conflict instead of " +
      "silently breaking it. If the change establishes something new that must stay true " +
      "from now on, add it on a line starting SPEC+ (max one per build, under 140 characters).\n\n";
    return out;
  }

  // Reads the model's reply for the two signals. Tolerant of formatting: the
  // model writes prose, so a line may arrive bolded, bulleted or punctuated.
  function parseReply(text) {
    const result = { added: [], conflicts: [] };
    if (typeof text !== "string" || !text) return result;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/^[\s>*\-#]+/, "").replace(/\*\*/g, "").trim();
      const add = line.match(/^SPEC\s*\+\s*:?\s*(.+)$/i);
      if (add) {
        const value = cleanLine(add[1], RULE_CHARS);
        if (value) result.added.push(value);
        continue;
      }
      const clash = line.match(/^SPEC\s*!\s*:?\s*(.+)$/i);
      if (clash) {
        const value = cleanLine(clash[1], RULE_CHARS * 2);
        if (value) result.conflicts.push(value);
      }
    }
    return result;
  }

  // A reply's SPEC+ lines should never be shown to the user as part of the
  // friendly note - they are bookkeeping, not conversation.
  function stripSpecLines(text) {
    if (typeof text !== "string") return "";
    return text
      .split(/\r?\n/)
      .filter((l) => !/^[\s>*\-#]*(?:\*\*)?SPEC\s*[+!]/i.test(l))
      .join("\n")
      .trim();
  }

  // Adding is capped and de-duplicated: a spec that grows without bound stops
  // being read, by the model and by the person.
  function withRules(spec, newRules, now) {
    const s = normalise(spec);
    let changed = false;
    for (const raw of newRules || []) {
      const text = cleanLine(raw, RULE_CHARS);
      if (!text) continue;
      if (s.rules.some((r) => r.text.toLowerCase() === text.toLowerCase())) continue;
      if (s.rules.length >= MAX_RULES) break;
      s.rules.push({ text });
      changed = true;
    }
    if (changed) s.updatedAt = now || new Date().toISOString();
    return s;
  }

  function withoutRule(spec, text) {
    const s = normalise(spec);
    const before = s.rules.length;
    s.rules = s.rules.filter((r) => r.text.toLowerCase() !== cleanLine(text, RULE_CHARS).toLowerCase());
    if (s.rules.length !== before) s.updatedAt = new Date().toISOString();
    return s;
  }

  function withPurpose(spec, purpose, now) {
    const s = normalise(spec);
    const value = cleanLine(purpose, PURPOSE_CHARS);
    if (value === s.purpose) return s;
    s.purpose = value;
    s.updatedAt = now || new Date().toISOString();
    return s;
  }

  return {
    MAX_RULES,
    RULE_CHARS,
    PURPOSE_CHARS,
    emptySpec,
    normalise,
    isEmpty,
    promptBlock,
    parseReply,
    stripSpecLines,
    withRules,
    withoutRule,
    withPurpose,
  };
});
