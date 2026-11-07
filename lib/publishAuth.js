/* Who may write to a published app or preview.

   Publishing used to take an optional app id from the request body and write
   that row with the service-role key, with no check on the caller. Every app's
   id is in its public URL, so anyone could overwrite anyone's live app. Writes
   now need a signed-in, email-confirmed account, and an existing id can only be
   written by the account that owns it (published_apps.owner_id, migration 012).

   Apps published before ownership existed have no owner. Nobody can prove they
   made one, so they are locked: the builder publishes the new version to a new
   link instead, and the old link keeps serving until it's moved by hand. */

// Returns { ok: true } or { ok: false, status, code, error }.
async function checkWriteAccess(db, { id, userId }) {
  if (!id) return { ok: true };
  const { data, error } = await db.from("published_apps").select("owner_id").eq("id", id).maybeSingle();
  if (error) {
    // Fail closed: if ownership can't be read, nothing is overwritten.
    return { ok: false, status: 503, code: "ownership_unavailable", error: "Could not check who owns this app. Try again in a minute." };
  }
  if (!data) return { ok: true }; // a fresh id nobody has used yet
  if (data.owner_id && data.owner_id === userId) return { ok: true };
  if (!data.owner_id) {
    return {
      ok: false,
      status: 409,
      code: "legacy_unowned",
      error: "This link was published before apps had owners, so it can't be updated from here.",
    };
  }
  return { ok: false, status: 403, code: "not_owner", error: "This app belongs to a different account." };
}

module.exports = { checkWriteAccess };
