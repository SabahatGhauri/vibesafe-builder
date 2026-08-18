// The Launch Check security gate.
//
// VibeSafe can make a project public. This is the part that decides whether it
// SHOULD be. Those are different questions, and the second one is the product.
//
// DESIGN RULES, in order of importance:
//
//  1. Never modify the user's code. This module reports; it does not rewrite,
//     redact, or "helpfully" strip anything. Silently removing a secret would
//     hide the fact that it was committed, pushed to GitHub, and is already
//     compromised — the user needs to know so they can ROTATE it.
//
//  2. Never echo a secret back. Findings carry a masked snippet. A scanner that
//     copies credentials into audit logs and error responses has made the leak
//     worse.
//
//  3. Severity, not a single blocklist. Blocking every deployment over a
//     missing security header trains people to look for the override, which is
//     how a real finding gets clicked past.
//
//  4. Report WHERE. A finding without a file and line is an accusation the user
//     cannot act on.
//
// SEVERITY MODEL
//   critical — a live credential. Blocks, and cannot be overridden.
//   high     — a serious flaw (code execution, credential theft). Blocks unless
//              the user explicitly overrides.
//   medium   — worth knowing before going public. Warns.
//   info     — advisory. Never blocks.

/* ---------------- what counts as a real secret ---------------- */

// Provider formats are high-confidence: these strings do not occur by accident,
// so a match is a leaked credential unless it is visibly a placeholder.
const CREDENTIAL_RULES = [
  { rule: "anthropic-key", label: "Anthropic API key", re: /\bsk-ant-[a-zA-Z0-9_-]{20,}/g },
  { rule: "openai-key", label: "OpenAI API key", re: /\bsk-(?:proj-)?[a-zA-Z0-9]{32,}/g },
  { rule: "aws-key", label: "AWS access key ID", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "google-key", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "github-token", label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}|\bgithub_pat_[a-zA-Z0-9_]{22,}/g },
  { rule: "stripe-key", label: "Stripe secret key", re: /\b(?:sk|rk)_live_[a-zA-Z0-9]{20,}/g },
  { rule: "vercel-token", label: "Vercel access token", re: /\bvcp_[a-zA-Z0-9]{40,}/g },
  { rule: "slack-token", label: "Slack token", re: /\bxox[baprs]-[a-zA-Z0-9-]{10,}/g },
  { rule: "sendgrid-key", label: "SendGrid API key", re: /\bSG\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g },
  { rule: "private-key", label: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    rule: "jwt-service-key",
    label: "Service-role JWT (full database access)",
    // A JWT is only a credential worth blocking on when it actually carries the
    // service_role claim — the anon key is a public value by design.
    re: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
    verify: (match) => {
      try {
        const payload = JSON.parse(Buffer.from(match.split(".")[1], "base64").toString("utf8"));
        return payload && (payload.role === "service_role" || payload.role === "admin");
      } catch {
        return false;
      }
    },
  },
  {
    rule: "db-url-password",
    label: "Database connection string with a password",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s"']+:[^@\s"']+@[^\s"']+/g,
    // The placeholder test must see only the PASSWORD. Run against the whole
    // URL it also reads the hostname, so "db.example.com" contains "example"
    // and a live password gets waved through.
    placeholderPart: (match) => {
      const m = match.match(/:\/\/[^:]+:([^@]+)@/);
      return m ? m[1] : match;
    },
  },
];

// A named assignment to a long, high-entropy value. Lower confidence than the
// formats above, so it is held to a stricter placeholder and entropy test.
// The optional quotes around the NAME matter: in JSON the key is written
// "apiKey": "…", and without them this rule silently skipped every JSON config
// file — exactly where secrets like to hide.
const ASSIGNMENT_RE =
  /["'`]?\b([A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|password|passwd|token|credential|private[_-]?key|auth)[A-Za-z0-9_]*)["'`]?\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/gi;

// Same thing in environment/config syntax: KEY=value with no quotes.
const ENV_ASSIGNMENT_RE =
  /^\s*(?:export\s+)?([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)[A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]{8,})["']?/i;

/* ---------------- non-credential rules ---------------- */

const CODE_RULES = [
  {
    rule: "eval",
    severity: "high",
    label: "Dynamic code execution (eval / new Function)",
    re: /\beval\s*\(|\bnew\s+Function\s*\(/,
    remediation: "Replace eval with a direct call. Anything reaching eval can run arbitrary code in your users' browsers.",
  },
  {
    rule: "builder-storage",
    severity: "high",
    label: "Reads the builder's own storage keys (possible credential theft)",
    re: /vc_apiKey|vc_project\b|vc_cap\b|sb-[\w-]+-auth-token|supabase\.auth\.(token|session)/i,
    remediation: "Remove this. These keys belong to VibeSafe itself, not to your app, and reading them exposes other people's credentials.",
  },
  {
    rule: "password-localstorage",
    severity: "high",
    label: "Password stored in localStorage",
    re: /localStorage\.(setItem\s*\(\s*["'][^"']*(password|passwd|secret)|[a-zA-Z_]*(password|passwd|secret))/i,
    remediation: "Never store passwords in the browser. Send them to a server and store only a hash.",
  },
  {
    rule: "tls-disabled",
    severity: "high",
    label: "TLS certificate verification disabled",
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/,
    remediation: "This makes encrypted connections trivially interceptable. Remove it.",
  },
  {
    rule: "http-auth",
    severity: "medium",
    label: "Credentials sent over plain HTTP",
    re: /fetch\s*\(\s*["']http:\/\/(?!localhost|127\.0\.0\.1)[^"']*(login|auth|signin|token|password)/i,
    remediation: "Use https:// — over http:// these credentials travel in the clear.",
  },
  {
    rule: "innerhtml",
    severity: "medium",
    label: "Untrusted value written to innerHTML",
    re: /\.innerHTML\s*=\s*(?!["'`])[a-zA-Z_$][\w$.]*/,
    remediation: "If that value can come from a user, this is an XSS hole. Use textContent, or escape it first.",
  },
  {
    rule: "cors-wildcard",
    severity: "info",
    label: "CORS allows any origin",
    re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/,
    remediation: "Fine for a public read-only API; not fine if the endpoint is authenticated.",
  },
];

/* ---------------- placeholder and entropy heuristics ---------------- */

// Documentation and examples are where false positives come from, and a scanner
// that cries wolf gets overridden by reflex. These are the shapes that mean
// "fill this in", not "here is my key".
//
// Every marker here is deliberately a WORD, not a digit run. An earlier version
// included "123456", which matched inside a perfectly real random key
// ("...Yz0123456789") and silently waved it through. A false negative in this
// module is far worse than a false positive, so the markers must be things that
// cannot occur by chance inside generated entropy.
const TEMPLATE_MARKERS =
  /your[_-]?|example|sample|placeholder|change[_-]?(?:me|this)|replace[_-]?|insert[_-]?|todo|fixme|dummy|fake|_here\b|goes[_-]?here|redacted|x{4,}|<[^>]*>|\{\{/i;

// Whole-value junk: only a placeholder when it IS the entire value, never as a
// substring of something longer.
const JUNK_VALUES =
  /^(?:abc123|123456+|password|passwd|secret|token|key|value|test|demo|none|null|undefined|true|false|string|foo|bar|baz|letmein|admin)$/i;

// A value that is really a reference to a secret, not a secret.
const REFERENCE_RE = /^\s*(?:process\.env\.|import\.meta\.env\.|Deno\.env|\$\{|\{\{|%[A-Z_]+%|\$[A-Z_]+$)/;

// Applied to provider-format credentials, which are trusted on shape alone.
// Strict on purpose: only an unmistakable template marker disqualifies a match.
function isPlaceholder(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (REFERENCE_RE.test(v)) return true;
  if (JUNK_VALUES.test(v)) return true;
  if (TEMPLATE_MARKERS.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true; // xxxxxxxx
  return false;
}

// Real credentials are long and mix character classes. A word from a sentence
// does not. This is only applied to the lower-confidence assignment rules —
// provider formats are trusted on shape alone.
function looksLikeSecret(value) {
  const v = String(value || "");
  if (v.length < 16) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(v)).length;
  if (classes >= 3) return true;
  if (v.length >= 32 && classes >= 2) return true;
  return false;
}

/* ---------------- file classification ---------------- */

const DOC_FILE = /\.(md|markdown|txt|rst)$/i;
const ENV_FILE = /(^|\/)\.env(\.|$)|(^|\/)\.?env(\.[a-z]+)?$/i;
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|conf|cfg)$/i;
const EXAMPLE_FILE = /(^|\/)(example|sample|template|fixture|mock)s?(\/|\.|$)|\.(example|sample|template)($|\.)/i;

function classify(path) {
  return {
    isDoc: DOC_FILE.test(path),
    isEnv: ENV_FILE.test(path),
    isConfig: CONFIG_FILE.test(path),
    isExample: EXAMPLE_FILE.test(path),
  };
}

/* ---------------- masking ---------------- */

// Findings travel into audit logs and HTTP responses, so the secret itself must
// never ride along. Enough is shown to locate it, never enough to use it.
function mask(secret) {
  const s = String(secret || "");
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 4) + "•".repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}

function maskedLine(line, secret) {
  const trimmed = String(line || "").trim().slice(0, 200);
  return secret ? trimmed.split(secret).join(mask(secret)) : trimmed;
}

/* ---------------- the scan ---------------- */

function scanFile(path, content, findings) {
  const kind = classify(path);
  const lines = String(content || "").split(/\r?\n/);

  // Provider-format credentials. Checked in every file type — a real key in a
  // README is still a real key, and it is about to be pushed to GitHub.
  for (const rule of CREDENTIAL_RULES) {
    lines.forEach((line, i) => {
      const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
      let m;
      while ((m = re.exec(line)) !== null) {
        const hit = m[0];
        if (isPlaceholder(rule.placeholderPart ? rule.placeholderPart(hit) : hit)) continue;
        if (rule.verify && !rule.verify(hit)) continue;
        findings.push({
          severity: "critical",
          rule: rule.rule,
          label: rule.label,
          file: path,
          line: i + 1,
          snippet: maskedLine(line, hit),
          remediation:
            "Remove it from the code and rotate the credential — treat it as already compromised. Use an environment variable instead.",
        });
      }
    });
  }

  // Named assignments. In documentation and example files these are downgraded
  // rather than dropped: "API_KEY=abc123def456..." in a README is usually a
  // teaching example, but it is still worth mentioning.
  lines.forEach((line, i) => {
    let m;
    const re = new RegExp(ASSIGNMENT_RE.source, ASSIGNMENT_RE.flags);
    while ((m = re.exec(line)) !== null) {
      const [, name, value] = m;
      if (isPlaceholder(value) || !looksLikeSecret(value)) continue;
      const doc = kind.isDoc || kind.isExample;
      findings.push({
        severity: doc ? "info" : "critical",
        rule: "hardcoded-secret",
        label: doc ? `Possible credential in documentation (${name})` : `Hardcoded credential (${name})`,
        file: path,
        line: i + 1,
        snippet: maskedLine(line, value),
        remediation: doc
          ? "If this is a real credential rather than an example, remove and rotate it."
          : "Move this to an environment variable and rotate the credential — assume it is already compromised.",
      });
    }
  });

  // Environment and config files: KEY=value form, which the quoted-assignment
  // rule above does not match.
  if (kind.isEnv || kind.isConfig) {
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return; // a commented-out line is not live config
      const m = line.match(ENV_ASSIGNMENT_RE);
      if (!m) return;
      const [, name, value] = m;
      if (isPlaceholder(value) || !looksLikeSecret(value)) return;
      findings.push({
        severity: kind.isExample ? "info" : "critical",
        rule: "secret-in-config",
        label: `Secret in ${kind.isEnv ? "environment" : "config"} file (${name})`,
        file: path,
        line: i + 1,
        snippet: maskedLine(line, value),
        remediation: kind.isExample
          ? "Example files should carry placeholder values only."
          : "This file is part of the deployment. Set it in your host's environment variables instead, and rotate the value.",
      });
    });
  }

  // A committed .env file is worth flagging even when its values look benign —
  // it is a file that is not supposed to travel with the code.
  if (kind.isEnv && !kind.isExample && String(content || "").trim()) {
    findings.push({
      severity: "medium",
      rule: "env-file-deployed",
      label: "Environment file included in the deployment",
      file: path,
      line: 1,
      snippet: "",
      remediation: "Add this to .gitignore and set the values in your host's environment settings instead.",
    });
  }

  // Code-quality and configuration rules. Documentation is exempt: prose about
  // eval is not eval.
  if (!kind.isDoc) {
    for (const rule of CODE_RULES) {
      lines.forEach((line, i) => {
        if (!rule.re.test(line)) return;
        findings.push({
          severity: rule.severity,
          rule: rule.rule,
          label: rule.label,
          file: path,
          line: i + 1,
          snippet: String(line).trim().slice(0, 200),
          remediation: rule.remediation,
        });
      });
    }
  }
}

// Scans every file in a project. `files` is {path: contents}.
function scanProject(files) {
  const findings = [];
  for (const [path, content] of Object.entries(files || {})) {
    if (typeof content !== "string") continue;
    scanFile(path, content, findings);
  }

  const counts = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const verdict = counts.critical
    ? "blocked"
    : counts.high
    ? "override_required"
    : counts.medium
    ? "warn"
    : "clean";

  // Worst first, so a UI that truncates still shows what matters.
  const order = { critical: 0, high: 1, medium: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

  return { verdict, counts, findings, scannedFiles: Object.keys(files || {}).length };
}

/* ---------------- the gate ---------------- */

// Whether a project may be exposed to the internet.
//
// A critical finding is a live credential, and no override exists for it: there
// is no legitimate reason to knowingly publish a working API key, and offering
// a button would guarantee someone eventually presses it. `high` can be
// overridden, but only by an explicit, separate acknowledgement.
function gateDecision(scan, { override = false } = {}) {
  if (scan.verdict === "blocked") {
    return {
      allowed: false,
      reason:
        scan.counts.critical === 1
          ? "A live credential was found in this project. Publishing it would expose that credential to anyone who visits the site."
          : `${scan.counts.critical} live credentials were found in this project. Publishing would expose them to anyone who visits the site.`,
      overridable: false,
    };
  }
  if (scan.verdict === "override_required" && !override) {
    return {
      allowed: false,
      reason: `${scan.counts.high} serious security ${scan.counts.high === 1 ? "issue was" : "issues were"} found. Review ${
        scan.counts.high === 1 ? "it" : "them"
      } before making this public.`,
      overridable: true,
    };
  }
  return { allowed: true, reason: null, overridable: false };
}

// A compact form safe to store in an audit log: counts and locations, never a
// snippet, because snippets are the one field that could still carry context
// about a secret.
function auditSummary(scan) {
  return {
    verdict: scan.verdict,
    counts: scan.counts,
    scannedFiles: scan.scannedFiles,
    findings: scan.findings
      .filter((f) => f.severity === "critical" || f.severity === "high")
      .map((f) => ({ severity: f.severity, rule: f.rule, file: f.file, line: f.line })),
  };
}

module.exports = { scanProject, gateDecision, auditSummary, mask, isPlaceholder, looksLikeSecret };
