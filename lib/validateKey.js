/* Check whether an Anthropic API key actually works.

   Without this the key is accepted silently and the first sign anything is wrong
   is a failed build - which reads as "the product is broken", not "I pasted the
   wrong key".

   Uses GET /v1/models: it is a metadata call, so it costs no tokens and consumes
   no budget, but it still exercises real authentication. A generation request
   would also prove the key works, and would bill the user for the privilege. */

// Anthropic keys look like sk-ant-... . Catching the obvious cases in the
// browser avoids a pointless round trip, but it is only a hint: the network
// check below is what actually decides.
function looksLikeKey(key) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, reason: "No key entered." };
  if (/\s/.test(k)) return { ok: false, reason: "That key contains a space — it was probably copied with extra text." };
  if (!k.startsWith("sk-ant-")) return { ok: false, reason: "Anthropic keys start with \"sk-ant-\". Check you copied the whole key." };
  if (k.length < 40) return { ok: false, reason: "That key looks too short — it may have been cut off when copied." };
  return { ok: true };
}

/* Maps a response to something a non-technical user can act on. The distinction
   that matters most is "your key is wrong" versus "we could not tell" - telling
   someone their key is invalid when the check merely timed out sends them off
   regenerating a key that was fine. */
function interpret(status) {
  if (status === 200) return { valid: true, message: "Key works — you're ready to build." };
  if (status === 401) return { valid: false, message: "Anthropic rejected this key. Check you copied it correctly, or create a new one." };
  if (status === 403) return { valid: false, message: "This key was recognised but is not permitted to use the API. Check its permissions in the Anthropic console." };
  if (status === 429) return { valid: null, message: "Anthropic is rate-limiting right now, so the key could not be checked. It was saved anyway." };
  if (status >= 500) return { valid: null, message: "Anthropic is having trouble right now, so the key could not be checked. It was saved anyway." };
  return { valid: null, message: `Could not check the key (HTTP ${status}). It was saved anyway.` };
}

async function validateAnthropicKey(key, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const shape = looksLikeKey(key);
  if (!shape.ok) return { valid: false, message: shape.reason, checked: false };

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": String(key).trim(),
        "anthropic-version": "2023-06-01",
      },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    return { ...interpret(r.status), checked: true };
  } catch (err) {
    // A network failure says nothing about the key, so it must not be reported
    // as invalid.
    return {
      valid: null,
      checked: false,
      message: "Couldn't reach Anthropic to check the key. It was saved — try a build to confirm it works.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { validateAnthropicKey, looksLikeKey, interpret };
