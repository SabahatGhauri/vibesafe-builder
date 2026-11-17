/* Decides whether a Stripe webhook event is proof that the Managed plan was
   paid for, before activateManagedAccess() marks anyone "active".

   checkout.session.completed fires when a checkout finishes, not when money
   arrives: with a delayed payment method it fires with payment_status "unpaid"
   and the money may never come. customer.subscription.created fires for
   subscriptions that are still "incomplete" (first payment not yet taken).
   Treating either as payment is how an account can sit at "active" for months
   with nothing ever paid.

   Pure function, no I/O, so it can be tested without Stripe. */

// "no_payment_required" is a checkout that Stripe itself settled at $0
// (a 100% coupon you issued, or a trial). That is a deliberate grant, so it
// still activates; only a checkout still waiting for money does not.
const PAID_CHECKOUT = new Set(["paid", "no_payment_required"]);
const ENTITLED_SUB = new Set(["active", "trialing"]);

function shouldActivate(event) {
  const type = event && event.type;
  const obj = (event && event.data && event.data.object) || {};
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return PAID_CHECKOUT.has(obj.payment_status);
    case "customer.subscription.created":
      return ENTITLED_SUB.has(obj.status);
    case "invoice.payment_succeeded":
      return true; // the event itself is the payment
    default:
      return false;
  }
}

module.exports = { shouldActivate };
