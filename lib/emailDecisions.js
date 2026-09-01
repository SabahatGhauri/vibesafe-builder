/* Pure decisions about WHICH email to send, kept separate from the webhook
   handler's I/O so they can be tested without a Stripe account or a database.

   Two real bugs motivated pulling this out rather than leaving it inline:

   1. activateManagedAccess() used to send "You're on the Pro plan" unconditionally,
      every time it ran. But checkout.session.completed, customer.subscription.created
      and invoice.payment_succeeded can all fire for the SAME purchase (that overlap
      is deliberate - see the webhook handler's "second chance" comment), so a single
      real purchase could double- or triple-send the activation email.

   2. There was no distinction between "brand-new customer, needs a set-password link"
      and "existing account reactivating a lapsed subscription" - a returning customer
      would have been told to "set your password" on an account that already has one.
*/

/* classifyActivation decides what an activation event actually is, from facts the
   caller already has before touching the database further:

   - isNewUser:  true if this Stripe email had no existing Supabase account at all.
   - oldStatus:  the subscriptions row's status BEFORE this event's upsert - undefined
                 if no row existed yet.

   Returns exactly one of:
   - "new"         - genuinely new account. Needs the set-password link.
   - "reactivated" - existing account, subscription was NOT active, now is. Already
                     has a way to log in - no set-password link needed.
   - "skip"        - was already active. A duplicate delivery of an event we've
                     already acted on - send nothing, or the customer gets spammed
                     with "you're on Pro" every time Stripe re-delivers. */
function classifyActivation({ isNewUser, oldStatus }) {
  if (isNewUser) return "new";
  if (oldStatus === "active") return "skip";
  return "reactivated";
}

/* Stripe retries a failed invoice several times over about two weeks (its "smart
   retries"), and fires invoice.payment_failed on EVERY attempt - not just the first.
   Emailing on each one would mean several near-identical "your card was declined"
   messages for a single underlying problem. Only the first attempt is worth an email;
   subsequent ones just report the same declined card again. */
function shouldSendPaymentFailedEmail(invoice) {
  return Number(invoice?.attempt_count) === 1;
}

module.exports = { classifyActivation, shouldSendPaymentFailedEmail };
