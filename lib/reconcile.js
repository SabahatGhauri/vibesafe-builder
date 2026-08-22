/* Reconcile Stripe subscriptions against our own subscriptions table.
   
   Webhooks are best-effort: Stripe retries for a few days and then gives up
   permanently. When one is missed - a deploy mid-delivery, a timeout, a bad
   signing secret after an account switch - a customer pays and never gets
   access, and nothing in the system notices. That happened here: Stripe showed
   two active subscriptions while the table held one.
   
   So this is the safety net. Stripe is the source of truth for who has paid;
   this walks its active subscriptions and reports (or repairs) anything the
   table disagrees about. Safe to run repeatedly. */

// Stripe treats trialing as entitled, and so does the webhook handler, so the
// two must agree or a trialing customer would be repaired into "canceled" here
// and back to active by the next webhook, forever.
const ENTITLED = new Set(["active", "trialing"]);

/* Pure comparison, kept separate from all I/O so it can be tested without a
   Stripe account or a database.
   
   stripeSubs: [{ id, status, customerId, email }]
   dbRows:     [{ user_id, stripe_customer_id, status }]
   
   Returns one entry per discrepancy, plus the matches, so a dry run can show
   the whole picture rather than only what is broken. */
function diffSubscriptions(stripeSubs, dbRows) {
  const byCustomer = new Map();
  for (const row of dbRows) {
    if (row.stripe_customer_id) byCustomer.set(row.stripe_customer_id, row);
  }

  const result = { missing: [], reactivate: [], stale: [], ok: [] };
  const seen = new Set();

  for (const sub of stripeSubs) {
    if (!ENTITLED.has(sub.status)) continue;
    seen.add(sub.customerId);
    const row = byCustomer.get(sub.customerId);
    if (!row) {
      // Paid, but we have no record at all - the webhook never landed.
      result.missing.push(sub);
    } else if (row.status !== "active") {
      // We have a record but it is switched off while Stripe says they are paying.
      result.reactivate.push({ ...sub, userId: row.user_id, dbStatus: row.status });
    } else {
      result.ok.push({ ...sub, userId: row.user_id });
    }
  }

  // Marked active for us, but Stripe has no entitled subscription for them -
  // someone getting the product for free after cancelling.
  for (const row of dbRows) {
    if (row.status === "active" && row.stripe_customer_id && !seen.has(row.stripe_customer_id)) {
      result.stale.push({ customerId: row.stripe_customer_id, userId: row.user_id });
    }
  }
  return result;
}

/* Pulls every entitled subscription out of Stripe, following pagination so a
   growing customer list can't silently truncate the comparison. */
async function fetchStripeSubscriptions(stripe) {
  const out = [];
  for (const status of ENTITLED) {
    let startingAfter;
    for (;;) {
      const page = await stripe.subscriptions.list({
        status,
        limit: 100,
        expand: ["data.customer"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const sub of page.data) {
        const customer = sub.customer;
        out.push({
          id: sub.id,
          status: sub.status,
          customerId: typeof customer === "string" ? customer : customer?.id,
          // A deleted customer object carries no email; keep the row so the
          // mismatch still surfaces rather than vanishing from the report.
          email: typeof customer === "object" ? customer?.email || null : null,
        });
      }
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }
  return out;
}

async function loadDbRows(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("user_id, stripe_customer_id, status");
  if (error) throw new Error("Could not read subscriptions: " + error.message);
  return data || [];
}

/* Reports by default and only writes when apply is true, so the destructive
   reading of a bug in here is opt-in rather than the default behaviour. */
async function reconcile({ stripe, supabaseAdmin, activate, apply = false }) {
  const [stripeSubs, dbRows] = await Promise.all([
    fetchStripeSubscriptions(stripe),
    loadDbRows(supabaseAdmin),
  ]);
  const diff = diffSubscriptions(stripeSubs, dbRows);

  const actions = [];
  if (apply) {
    for (const sub of diff.missing) {
      if (!sub.email) {
        actions.push({ type: "missing", customerId: sub.customerId, done: false, error: "no email on Stripe customer" });
        continue;
      }
      try {
        await activate(sub.email, sub.customerId);
        actions.push({ type: "missing", customerId: sub.customerId, email: sub.email, done: true });
      } catch (err) {
        actions.push({ type: "missing", customerId: sub.customerId, email: sub.email, done: false, error: err.message });
      }
    }
    for (const sub of diff.reactivate) {
      try {
        const { error } = await supabaseAdmin
          .from("subscriptions")
          .update({ status: "active", updated_at: new Date().toISOString() })
          .eq("stripe_customer_id", sub.customerId);
        if (error) throw new Error(error.message);
        actions.push({ type: "reactivate", customerId: sub.customerId, done: true });
      } catch (err) {
        actions.push({ type: "reactivate", customerId: sub.customerId, done: false, error: err.message });
      }
    }
    // Deliberately NOT auto-cancelling stale rows. Revoking a real customer's
    // access on a bad read is far worse than briefly over-serving one, so these
    // are reported for a human to action.
  }

  return {
    checkedInStripe: stripeSubs.length,
    rowsInDb: dbRows.length,
    missing: diff.missing.map((s) => ({ customerId: s.customerId, email: s.email })),
    reactivate: diff.reactivate.map((s) => ({ customerId: s.customerId, dbStatus: s.dbStatus })),
    stale: diff.stale,
    okCount: diff.ok.length,
    applied: apply,
    actions,
  };
}

module.exports = { diffSubscriptions, fetchStripeSubscriptions, reconcile, ENTITLED };
