# Native VibeSafe Forms — initial release

Contact and waitlist forms use our Express API and existing Supabase database. Optional notifications use our existing Resend transport. There is no PortForm account or third-party form backend, and receiving submissions makes no LLM calls. Hosting, database and mail services remain infrastructure dependencies.

## Enable

1. Apply `db/migrations/005_native_forms.sql` through the existing database migration process before deploying the application. This creates two RLS-protected, server-only tables and two service-role-only functions. It does not modify existing app records.
2. Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` provide server storage access. Existing `RESEND_API_KEY` and mail sender settings provide optional email delivery.
3. Sign in with a verified email, open Forms, create a contact form or waitlist, and choose whether to receive email. Then use Add to build prompt or copy the HTML.
4. Test against a dedicated test database first. Create a form, submit synthetic data, check the inbox as its owner, verify another owner cannot read it, pause it, and verify submissions are refused. Test mail only with a destination you own and have explicitly chosen for testing.

## Behavior and limits

- Fields: contact has name (optional, 120 chars), email (required, 254), message (required, 4,000); waitlist has name and email. Unknown fields are discarded.
- Public UUID form IDs grant submission access only. They do not authorize reads or management.
- Owners authenticate using the existing `x-vc-session` mechanism. Create, list, pause/resume and inbox queries enforce owner scope. Recipients come only from the verified account email at creation, never from a submission.
- Submissions are committed before notification. A failed notification leaves a `failed` inbox entry; an interrupted status update may leave `pending`. `sent` means accepted by the email provider, not delivered to a mailbox. There is no automatic retry worker yet.
- Notification transport has a ten-second timeout and a per-submission email idempotency key.
- Pilot limits: 20 forms/account; 300 accepted submissions/account/calendar month in UTC; 1,000 retained submissions/account; 10 accepted submissions/form/minute. Limits use PostgreSQL transaction locks across server instances. No automatic data purge is implemented. A full inbox rejects further submissions until a future retention-management feature or an administrator handles it.
- A honeypot silently drops obvious bot submissions. This and volume limits are basic controls, not a guarantee of spam prevention. Per-IP challenges, CAPTCHA, attachments, webhooks, MCP tools and a dedicated no-email sandbox are not in this release.
- JSON submission returns `{ok:true}` only after storage succeeds. Plain URL-encoded HTML submissions receive a simple confirmation page. No arbitrary redirect is accepted.
- The copied snippet uses the current builder origin. Published VibeSafe apps allow the canonical `SITE_URL` origin's `/api/forms/public/` path in their submission policies, including on the isolated apps domain. Create production snippets from the canonical builder address. If an app is moved to another host with a restrictive CSP, permit that exact submission path for `form-action` (HTML) or `connect-src` (fetch). Do not broaden it to a wildcard.
- Inbox text is rendered as text, email values are HTML-escaped, and provider/database error details are not sent to public submitters. No submissions are included in generation prompts.

## Routes

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/forms/public/:id/submit` | Public write-only; honeypot and database quotas |
| GET | `/api/forms` | Signed-in owner: list forms |
| POST | `/api/forms` | Verified owner: create form |
| PATCH | `/api/forms/:id` | Owner: set enabled boolean |
| GET | `/api/forms/:id/submissions` | Owner: up to 1,000 newest submissions |

Run `node --test test/forms.test.js` for offline route and isolation checks. These use a fake database: SQL concurrency and migration execution still require a PostgreSQL integration check before enabling production.
