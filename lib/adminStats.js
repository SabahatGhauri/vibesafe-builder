/* Owner-dashboard data beyond the managed-user table: anonymous generation
   activity (so bring-your-own-key users stop being invisible), Stripe revenue,
   and published apps.

   Each section loads independently and reports its own failure. Stripe being
   unreachable, or migration 004 not yet applied, must never blank the rest of
   the dashboard. */

const STAT_MODES = ["byok", "managed"];
const MIGRATION_HINT = "Apply db/migrations/004_generation_stats.sql to enable this section.";
const DAY_MS = 24 * 60 * 60 * 1000;

// Recorded after every generation. Aggregate only - one counter row per UTC day
// per mode - so it holds nothing that could identify a user. Never throws: a
// stats hiccup must not affect the generation the user is waiting on.
async function recordGenerationStat(supabaseAdmin, { mode, cost, succeeded }) {
  if (!supabaseAdmin || !STAT_MODES.includes(mode)) return;
  try {
    const { error } = await supabaseAdmin.rpc("record_generation_stat", {
      p_mode: mode,
      p_cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      p_succeeded: !!succeeded,
    });
    if (error) console.error("Could not record generation stat:", error.message);
  } catch (err) {
    console.error("Could not record generation stat:", err.message);
  }
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function windowStart(now, days) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
}

// Missing-table errors look different depending on which layer reports them:
// Postgres says 42P01, PostgREST's schema cache says PGRST205.
function isMissingTableError(error) {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message || "");
}

// Turns raw rows into a gap-free daily series (days with no activity are zeros,
// not missing) plus per-mode totals. Rows outside the window or with an unknown
// mode are ignored rather than trusted.
function summarizeDailyStats(rows, { days = 30, now = new Date() } = {}) {
  const series = [];
  const byDay = {};
  const start = windowStart(now, days);
  for (let i = 0; i < days; i++) {
    const point = { day: utcDay(new Date(start.getTime() + i * DAY_MS)), byok: 0, managed: 0, failures: 0 };
    byDay[point.day] = point;
    series.push(point);
  }

  const totals = {};
  for (const mode of STAT_MODES) totals[mode] = { builds: 0, failures: 0, cost: 0 };

  for (const row of rows || []) {
    const total = totals[row.mode];
    const point = byDay[String(row.day).slice(0, 10)];
    if (!total || !point) continue;
    const builds = Number(row.builds) || 0;
    const failures = Number(row.failures) || 0;
    total.builds += builds;
    total.failures += failures;
    total.cost += Number(row.cost) || 0;
    point[row.mode] += builds;
    point.failures += failures;
  }

  const activeDays = series.filter((p) => p.byok + p.managed + p.failures > 0).length;
  return { days, series, totals, activeDays };
}

async function fetchActivity(supabaseAdmin, { days = 30, now = new Date() } = {}) {
  const { data, error } = await supabaseAdmin
    .from("generation_stats")
    .select("day, mode, builds, failures, cost")
    .gte("day", utcDay(windowStart(now, days)));
  if (isMissingTableError(error)) return { available: false, reason: MIGRATION_HINT };
  if (error) throw error;
  return { available: true, ...summarizeDailyStats(data, { days, now }) };
}

// Normalises one subscription item to a monthly amount in the smallest currency
// unit. Uses the list price: coupons and discounts are not subtracted, so this
// is "what the plans are worth", which the paid-invoices figure complements.
function monthlyAmountCents(item) {
  const price = item && (item.price || item.plan);
  if (!price) return 0;
  const unit = price.unit_amount ?? price.amount ?? 0;
  const recurring = price.recurring || { interval: price.interval, interval_count: price.interval_count };
  const perMonth = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[recurring && recurring.interval];
  if (perMonth === undefined) return 0;
  const count = recurring.interval_count || 1;
  return (unit * (item.quantity || 1) * perMonth) / count;
}

function addTo(map, currency, cents) {
  const key = (currency || "usd").toLowerCase();
  map[key] = (map[key] || 0) + cents;
}

function toMoneyList(map) {
  return Object.entries(map)
    .map(([currency, cents]) => ({ currency, cents: Math.round(cents) }))
    .sort((a, b) => b.cents - a.cents);
}

// active and past_due are paying (past_due is still owed and usually recovers);
// trialing is counted separately because it has not paid anything yet.
function computeRevenue(subscriptions, { now = new Date(), days = 30 } = {}) {
  const since = now.getTime() / 1000 - days * 86400;
  const mrr = {};
  const counts = { paying: 0, trialing: 0, pastDue: 0, canceledRecently: 0 };
  for (const sub of subscriptions || []) {
    if (sub.status === "active" || sub.status === "past_due") {
      counts.paying++;
      if (sub.status === "past_due") counts.pastDue++;
      for (const item of (sub.items && sub.items.data) || []) {
        addTo(mrr, sub.currency || (item.price && item.price.currency), monthlyAmountCents(item));
      }
    } else if (sub.status === "trialing") {
      counts.trialing++;
    } else if (sub.status === "canceled" && sub.canceled_at && sub.canceled_at >= since) {
      counts.canceledRecently++;
    }
  }
  return { mrr: toMoneyList(mrr), ...counts };
}

// Hard stop on pagination so a surprise-large account cannot hang the dashboard.
const MAX_STRIPE_OBJECTS = 2000;

async function collect(list) {
  const out = [];
  for await (const obj of list) {
    out.push(obj);
    if (out.length >= MAX_STRIPE_OBJECTS) break;
  }
  return out;
}

async function fetchRevenue(stripe, { configured = true, now = new Date(), days = 30 } = {}) {
  if (!configured || !stripe) return { available: false, reason: "STRIPE_SECRET_KEY is not set on this server." };
  const since = Math.floor(now.getTime() / 1000) - days * 86400;

  const [subscriptions, invoices, account] = await Promise.all([
    collect(stripe.subscriptions.list({ status: "all", limit: 100 })),
    collect(stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })),
    // Which account the key belongs to is the single most useful fact here: this
    // business has more than one Stripe account, and revenue on the others is
    // invisible to this server. Optional - restricted keys may not be allowed it.
    stripe.accounts.retrieve().catch(() => null),
  ]);

  const paid = {};
  for (const inv of invoices) addTo(paid, inv.currency, inv.amount_paid || 0);

  return {
    available: true,
    account: account
      ? {
          id: account.id,
          name:
            (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) ||
            (account.business_profile && account.business_profile.name) ||
            null,
        }
      : null,
    ...computeRevenue(subscriptions, { now, days }),
    paidLast30: toMoneyList(paid),
    truncated: subscriptions.length >= MAX_STRIPE_OBJECTS || invoices.length >= MAX_STRIPE_OBJECTS,
  };
}

// Counts and the most recently updated apps. Selects ids and timestamps only -
// never the html column, which can be large and is not needed here.
async function fetchPublishedApps(supabaseAdmin, { now = new Date(), recentLimit = 10 } = {}) {
  const count = (sinceDays) => {
    let q = supabaseAdmin.from("published_apps").select("id", { count: "exact", head: true });
    if (sinceDays) q = q.gte("created_at", new Date(now.getTime() - sinceDays * DAY_MS).toISOString());
    return q;
  };
  const [total, last7, last30, recent] = await Promise.all([
    count(null),
    count(7),
    count(30),
    supabaseAdmin
      .from("published_apps")
      .select("id, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(recentLimit),
  ]);
  for (const r of [total, last7, last30, recent]) if (r.error) throw r.error;
  return {
    available: true,
    total: total.count || 0,
    last7: last7.count || 0,
    last30: last30.count || 0,
    recent: (recent.data || []).map((a) => ({ id: a.id, createdAt: a.created_at, updatedAt: a.updated_at })),
  };
}

function settle(promise) {
  return Promise.resolve()
    .then(() => promise())
    .catch((err) => ({ available: false, error: (err && err.message) || "Unknown error" }));
}

async function loadAdminStats({ supabaseAdmin, stripe, stripeConfigured, now = new Date() }) {
  const [activity, revenue, apps] = await Promise.all([
    settle(() => fetchActivity(supabaseAdmin, { now })),
    settle(() => fetchRevenue(stripe, { configured: stripeConfigured, now })),
    settle(() => fetchPublishedApps(supabaseAdmin, { now })),
  ]);
  return { generatedAt: now.toISOString(), activity, revenue, apps };
}

module.exports = {
  recordGenerationStat,
  summarizeDailyStats,
  isMissingTableError,
  fetchActivity,
  monthlyAmountCents,
  computeRevenue,
  fetchRevenue,
  fetchPublishedApps,
  loadAdminStats,
};
