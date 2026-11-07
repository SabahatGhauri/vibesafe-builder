/* Spend protection for builds that run on the platform's Anthropic key
   (the Managed plan and the free trial).

   Two problems this closes:

   1. Parallel builds. The budget is checked once, before a build starts. Twenty
      builds fired at the same moment each passed that check, so one account at
      $9.99 of a $10 budget could run up about $30. Now each account gets one
      build in flight at a time (generation_locks, migration 012).

   2. Lost writes. Spend used to be saved as read-then-write, so two builds that
      finished together could overwrite each other and record less than was
      actually spent. add_usage() does the addition inside Postgres instead.

   Both fall back to the old behaviour, loudly, if migration 012 hasn't been
   applied yet, so deploying the code first can't take the builder down. */

// A build is capped at the function's 300s limit, so a lock older than this
// belongs to a request that died without releasing it.
const LOCK_STALE_MS = 6 * 60 * 1000;

function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const msg = String(error.message || "");
  // 42P01 undefined_table, 42883 undefined_function, PGRST202/PGRST205 schema cache misses.
  return code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /does not exist|schema cache/i.test(msg);
}

let warnedLock = false;
let warnedAdd = false;

// Returns true when this request may start a build for userId.
async function acquireBuildLock(db, userId, now = Date.now()) {
  const { error } = await db.from("generation_locks").insert({ user_id: userId, locked_at: new Date(now).toISOString() });
  if (!error) return true;
  if (isMissingRelation(error)) {
    if (!warnedLock) {
      console.error("[usageGuard] generation_locks is missing - run db/migrations/012. Builds are not serialised until then.");
      warnedLock = true;
    }
    return true;
  }
  if (error.code !== "23505") {
    // Unknown failure: refuse rather than risk unbounded parallel spend.
    console.error("[usageGuard] could not take build lock for", userId, error.message);
    return false;
  }
  // Someone holds it. Take it over only if it is stale, and only if nobody else
  // took it over first (the eq on the old timestamp makes that a compare-and-set).
  const { data: row } = await db.from("generation_locks").select("locked_at").eq("user_id", userId).maybeSingle();
  if (!row) return false;
  if (now - new Date(row.locked_at).getTime() < LOCK_STALE_MS) return false;
  const { data: taken } = await db
    .from("generation_locks")
    .update({ locked_at: new Date(now).toISOString() })
    .eq("user_id", userId)
    .eq("locked_at", row.locked_at)
    .select("user_id");
  return Array.isArray(taken) && taken.length === 1;
}

async function releaseBuildLock(db, userId) {
  try {
    const { error } = await db.from("generation_locks").delete().eq("user_id", userId);
    if (error && !isMissingRelation(error)) console.error("[usageGuard] could not release build lock for", userId, error.message);
  } catch (err) {
    console.error("[usageGuard] could not release build lock for", userId, err.message);
  }
}

// Atomically adds cost (and one build, on success) to a managed_usage row.
async function addUsage(db, { userId, period, amount, succeeded, now = new Date() }) {
  const cost = Number.isFinite(amount) && amount > 0 ? amount : 0;
  if (typeof db.rpc === "function") {
    const { error } = await db.rpc("add_usage", {
      p_user: userId,
      p_period: period,
      p_amount: cost,
      p_build: succeeded ? 1 : 0,
    });
    if (!error) return;
    if (!isMissingRelation(error)) throw error;
    if (!warnedAdd) {
      console.error("[usageGuard] add_usage() is missing - run db/migrations/012. Falling back to read-then-write.");
      warnedAdd = true;
    }
  }
  const { data, error: readError } = await db
    .from("managed_usage")
    .select("dollars_spent, build_count")
    .eq("user_id", userId)
    .eq("period", period)
    .maybeSingle();
  if (readError) throw readError;
  const { error } = await db.from("managed_usage").upsert({
    user_id: userId,
    period,
    dollars_spent: (Number(data?.dollars_spent) || 0) + cost,
    build_count: (data?.build_count || 0) + (succeeded ? 1 : 0),
    updated_at: now.toISOString(),
  });
  if (error) throw error;
}

// The most output tokens a build can afford with what's left of a budget.
// Output is the expensive side, so it's what bounds the overshoot of a single
// build. Never below `floor`, so a build always has room to produce something.
function maxTokensFor({ remaining, outputPerMTok, ceiling, floor = 4000 }) {
  if (!Number.isFinite(remaining) || remaining <= 0) return floor;
  const affordable = Math.floor((remaining / outputPerMTok) * 1e6);
  return Math.max(floor, Math.min(ceiling, affordable));
}

module.exports = { acquireBuildLock, releaseBuildLock, addUsage, maxTokensFor, isMissingRelation, LOCK_STALE_MS };
