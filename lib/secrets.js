// Encryption for third-party credentials held on a user's behalf.
//
// Extracted from lib/github.js once a second integration (Vercel) needed the
// same thing. Two copies of crypto code is exactly the kind of duplication that
// drifts, and only one copy would end up getting fixed.
//
// Each caller gets its own key, derived with a DOMAIN string, so a GitHub
// ciphertext can never be decrypted by the Vercel path or vice versa — even
// though both ultimately derive from the same server secret.

const crypto = require("crypto");

// Prefers an explicit secret; falls back to the service-role key so a feature
// works without extra deployment config. The trade-off: rotating that key makes
// existing ciphertexts undecryptable, and users reconnect. decrypt() returns
// null rather than throwing in that case, so a rotation degrades to "reconnect"
// instead of a crash.
function keyFor(domain, explicitEnvVar) {
  const explicit = explicitEnvVar ? process.env[explicitEnvVar] : null;
  const base = explicit || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return crypto.createHash("sha256").update(domain + "|" + base).digest();
}

function makeCipher(domain, explicitEnvVar) {
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined) return null;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(domain, explicitEnvVar), iv);
      const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
      return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
    },

    decrypt(payload) {
      if (!payload) return null;
      try {
        const [ivB, tagB, ctB] = String(payload).split(".");
        if (!ivB || !tagB || !ctB) return null;
        const d = crypto.createDecipheriv("aes-256-gcm", keyFor(domain, explicitEnvVar), Buffer.from(ivB, "base64"));
        d.setAuthTag(Buffer.from(tagB, "base64"));
        return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
      } catch {
        // Wrong key, tampering, or corruption all mean the same thing to a
        // caller: there is no usable credential here.
        return null;
      }
    },

    // Shown in the UI instead of the credential itself. The token is never sent
    // to the browser, not even to display it.
    hint(plain) {
      const s = String(plain || "");
      if (s.length < 8) return "••••";
      return s.slice(0, 4) + "••••" + s.slice(-4);
    },
  };
}

module.exports = { makeCipher };
