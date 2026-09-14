/* Free trial builds.

   A signed-in account with no active subscription and no API key of its own used
   to hit a wall before seeing the product do anything ("add an Anthropic key").
   It now gets a small number of builds on the platform key instead, on a cheaper
   model than paid builds use.

   Spend is bounded three ways, all configurable without a code change:
     STARTER_BUILDS       successful free builds per account, ever   (default 1)
     STARTER_USER_CAP     dollars one account can cost, ever         (default $0.15)
     STARTER_MONTHLY_CAP  dollars all free builds together, per month (default $2)
     STARTER_BUILDS_ENABLED=off                                       kill switch

   Usage lives in the existing managed_usage table under two period keys, so no
   migration is needed: "starter" (per account, lifetime) and "starter-YYYY-MM"
   (per account, this month - summed across accounts for the monthly cap). The
   Managed plan reads only "YYYY-MM" periods, so these rows never touch its budget.

   Known limit: several builds fired at the same moment can each pass the check
   before any of them is recorded. The monthly cap bounds that worst case. */

const STARTER_MODEL = "claude-sonnet-5";
const STARTER_MODEL_LABEL = "Claude Sonnet 5";
const PAID_MODEL_LABEL = "Claude Opus 5";
// Dollars per million tokens for STARTER_MODEL.
const STARTER_PRICING = { input: 2.0, output: 10.0 };
// Smaller than paid builds' 64000 so one free build cannot run up a large bill.
const STARTER_MAX_TOKENS = 32000;

const LIFETIME_PERIOD = "starter";

function monthPeriod(now = new Date()) {
  return `starter-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function starterConfig(env = process.env) {
  const nonNegative = (value, fallback) => {
    if (value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    enabled: String(env.STARTER_BUILDS_ENABLED || "on").trim().toLowerCase() !== "off",
    builds: Math.floor(nonNegative(env.STARTER_BUILDS, 1)),
    perUserCap: nonNegative(env.STARTER_USER_CAP, 0.15),
    monthlyCap: nonNegative(env.STARTER_MONTHLY_CAP, 2),
  };
}

// Pure decision, so every branch is unit-testable without a database.
//   usage       this account's lifetime { spent, builds }
//   monthSpent  all accounts' free-build spend this month
function decideStarter({ config, usage, monthSpent }) {
  const buildsTotal = config.builds;
  if (!config.enabled || buildsTotal <= 0) {
    return { available: false, reason: "disabled", buildsLeft: 0, buildsTotal };
  }
  const buildsLeft = Math.max(0, buildsTotal - (usage.builds || 0));
  // Failed attempts cost money without using up a build, so the dollar cap is
  // what stops an account retrying failures for free indefinitely.
  if (buildsLeft === 0 || (usage.spent || 0) >= config.perUserCap) {
    return { available: false, reason: "used", buildsLeft: 0, buildsTotal };
  }
  if ((monthSpent || 0) >= config.monthlyCap) {
    return { available: false, reason: "paused", buildsLeft, buildsTotal };
  }
  return { available: true, reason: null, buildsLeft, buildsTotal };
}

function costFor(usage, pricing) {
  const inTok =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return (inTok / 1e6) * pricing.input + (outTok / 1e6) * pricing.output;
}

async function readRow(db, userId, period) {
  const { data, error } = await db
    .from("managed_usage")
    .select("dollars_spent, build_count")
    .eq("user_id", userId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return { spent: Number(data?.dollars_spent) || 0, builds: data?.build_count || 0 };
}

async function monthSpend(db, now = new Date()) {
  const { data, error } = await db.from("managed_usage").select("dollars_spent").eq("period", monthPeriod(now));
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + (Number(row.dollars_spent) || 0), 0);
}

// Fails closed: if usage cannot be read, no free build is given away.
async function checkStarter(db, userId, config, now = new Date()) {
  if (!config.enabled) return decideStarter({ config, usage: {}, monthSpent: 0 });
  try {
    const [usage, spent] = await Promise.all([readRow(db, userId, LIFETIME_PERIOD), monthSpend(db, now)]);
    return decideStarter({ config, usage, monthSpent: spent });
  } catch (err) {
    console.error("Free trial check failed:", err.message);
    return { available: false, reason: "disabled", buildsLeft: 0, buildsTotal: config.builds };
  }
}

// Every attempt's cost is recorded; only successes use up a build - the same
// split the Managed plan uses.
async function recordStarterUsage(db, userId, cost, succeeded, now = new Date()) {
  const amount = Number.isFinite(cost) && cost > 0 ? cost : 0;
  for (const period of [LIFETIME_PERIOD, monthPeriod(now)]) {
    const prev = await readRow(db, userId, period);
    const { error } = await db.from("managed_usage").upsert({
      user_id: userId,
      period,
      dollars_spent: prev.spent + amount,
      build_count: prev.builds + (succeeded ? 1 : 0),
      updated_at: now.toISOString(),
    });
    if (error) throw error;
  }
}

function starterUnavailableMessage(reason) {
  if (reason === "used") {
    return `You've used your free trial build. To keep building, add your own Anthropic API key in Settings (you pay Anthropic directly, no markup) or upgrade to Pro. Both use our most capable model, ${PAID_MODEL_LABEL}.`;
  }
  if (reason === "paused") {
    return `Free trial builds have reached this month's limit and are paused until next month. To build now, add your own Anthropic API key in Settings or upgrade to Pro. Both use ${PAID_MODEL_LABEL}.`;
  }
  return null;
}

module.exports = {
  STARTER_MODEL,
  STARTER_MODEL_LABEL,
  PAID_MODEL_LABEL,
  STARTER_PRICING,
  STARTER_MAX_TOKENS,
  LIFETIME_PERIOD,
  monthPeriod,
  starterConfig,
  decideStarter,
  costFor,
  checkStarter,
  monthSpend,
  recordStarterUsage,
  starterUnavailableMessage,
};
