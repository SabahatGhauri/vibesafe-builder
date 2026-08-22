/* Look up a Supabase auth user by email address.

   This exists because the obvious version is silently wrong. Supabase's admin
   endpoint GET /auth/v1/admin/users accepts only `page` and `per_page` - there
   is no email filter. Passing ?email=someone@example.com does not error and
   does not filter: it returns the first page of EVERY user, so taking users[0]
   hands back an arbitrary account rather than the one that just paid.

   With a single user in the project that is right by coincidence. With two it
   starts attaching subscriptions to the wrong person, which is how a real
   payment once activated a stranger's account.

   So: page through, and match the address explicitly. */

const PER_PAGE = 200;
// Bounded so a malformed response that always looks "full" cannot spin forever.
const MAX_PAGES = 50;

/* Exact, case-insensitive match. Email comparison is deliberately not fuzzy -
   activating the wrong account is far worse than failing to find one, and a
   near-miss is a different person. */
function pickUserByEmail(users, email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target || !Array.isArray(users)) return null;
  const hit = users.find((u) => String(u && u.email || "").trim().toLowerCase() === target);
  return hit || null;
}

/* fetchImpl is injectable purely so this can be tested without a live project. */
async function findUserIdByEmail(email, { supabaseUrl, serviceRoleKey, fetchImpl = fetch } = {}) {
  const target = String(email || "").trim();
  if (!target || !supabaseUrl || !serviceRoleKey) return null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`;
    const r = await fetchImpl(url, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    // A failed page means we cannot prove the user is absent. Returning null
    // here makes the caller create a new account - wrong, but far safer than
    // returning somebody else's id.
    if (!r.ok) return null;

    const body = await r.json();
    const users = Array.isArray(body) ? body : body && body.users;
    if (!Array.isArray(users) || users.length === 0) return null;

    const hit = pickUserByEmail(users, target);
    if (hit) return hit.id;

    // A short page is the last page; anything else means keep going.
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

module.exports = { findUserIdByEmail, pickUserByEmail, PER_PAGE, MAX_PAGES };
