/* Self-serve cancellation for the Managed plan.

   Cancelling never ends access on the spot. It sets cancel_at_period_end on the
   Stripe subscription, so the customer keeps Pro for the time they have already
   paid for, and Stripe sends customer.subscription.deleted when that time runs
   out. The existing webhook handler already turns that event into status
   "canceled" and sends the cancellation email, so nothing here writes to the
   subscriptions table: Stripe stays the source of truth.

   Until the period ends the customer can change their mind, which clears
   cancel_at_period_end again.

   Each function takes the Stripe client as an argument so the tests can pass a
   fake one. */

// Subscriptions that still bill or still grant access. "canceled",
// "incomplete_expired" and "unpaid" have nothing left to cancel.
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

// Since API version 2025-03-31.basil the billing period lives on each
// subscription item, not on the subscription itself. Read both so this keeps
// working whichever shape Stripe returns.
function periodEnd(sub) {
  const fromItem = sub?.items?.data?.[0]?.current_period_end;
  const seconds = sub?.cancel_at || fromItem || sub?.current_period_end || null;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function describe(sub) {
  if (!sub) return { hasSubscription: false };
  return {
    hasSubscription: true,
    status: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    periodEnd: periodEnd(sub),
  };
}

// The customer's one live subscription. A customer should only ever have one,
// but if there are several the newest is the one they are thinking of.
async function findLiveSubscription(stripe, customerId) {
  if (!customerId) return null;
  const { data } = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const live = (data || []).filter((s) => LIVE_STATUSES.has(s.status));
  live.sort((a, b) => (b.created || 0) - (a.created || 0));
  return live[0] || null;
}

async function getSubscription(stripe, customerId) {
  return describe(await findLiveSubscription(stripe, customerId));
}

async function cancelAtPeriodEnd(stripe, customerId) {
  const sub = await findLiveSubscription(stripe, customerId);
  if (!sub) return { hasSubscription: false };
  // Asking twice is harmless, and saying so is clearer than an error.
  if (sub.cancel_at_period_end) return { ...describe(sub), alreadyCanceling: true };
  const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  return describe(updated);
}

async function resume(stripe, customerId) {
  const sub = await findLiveSubscription(stripe, customerId);
  if (!sub) return { hasSubscription: false };
  if (!sub.cancel_at_period_end && !sub.cancel_at) return describe(sub);
  // A cancellation made here sets cancel_at_period_end. One scheduled from the
  // Stripe Dashboard for a specific date sets cancel_at instead, and an empty
  // string is how Stripe clears it. Send only the field that is set.
  const change = sub.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: "" };
  const updated = await stripe.subscriptions.update(sub.id, change);
  return describe(updated);
}

module.exports = { describe, periodEnd, findLiveSubscription, getSubscription, cancelAtPeriodEnd, resume, LIVE_STATUSES };
