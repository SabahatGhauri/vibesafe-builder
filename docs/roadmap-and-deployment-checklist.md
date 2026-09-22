# VibeSafe Builder: suggestions and deployment checklist

Updated: 22 September 2026.

This is a planning checklist, not authorization to implement or deploy every item. Unchecked items are
proposals or outstanding checks, not claims that the current product lacks every listed capability. Audit
existing features before implementing duplicates.

**Section 0 is the live to-do list.** Sections 1-6 are the original planning notes, kept for their reasoning.

## 0. Live to-do list

### Needs a human — I cannot do these

- [ ] **Test Forms end to end.** Create a form in the builder, submit to it, confirm the submission
      appears in the inbox AND that the notification email arrives. Nothing has exercised this path:
      0 forms created, 0 submissions. Resend delivery is the likeliest failure point.
- [ ] **Fix the Stripe display name.** Dashboard -> Settings -> Business -> Public details.
      `Vibesafe Builder ` (lowercase s, trailing space) should be `VibeSafe Builder`. Also check the
      statement descriptor and the Managed product name. Shows on receipts and card statements.
- [ ] **Request indexing** in Search Console for the 7 pages Google has not indexed:
      pricing, templates, what-is-vibesafe-builder, security, user-guide, how-to-build-your-first-app,
      ai-app-builder-checklist.
- [ ] **Backlinks.** Every current link is either from a site we own or `nofollow`. Independent
      followed links are the single biggest constraint on brand-name search. Directories, a Show HN
      repost in a few weeks, articles on Dev.to or Hashnode.

### Next features, in order

- [ ] **1. Payments in generated apps** (~2 days). The one capability Lovable has that we do not.
      Phase 1: customer pastes a Stripe payment link, AI builds checkout buttons, no secrets anywhere.
      Phase 2: connected Stripe account, server-side Checkout Sessions, webhook writes paid orders
      into the app's data store. Phase 3: subscriptions. Security scan must treat a hardcoded
      `sk_live` key as a publish-blocking critical.
- [ ] **2. App Spec** (~2-3 days). A living document of what the app must do: the AI reads it before
      each build and updates it after. Warns when a change would break something the spec says must
      hold. Answers the complaint common to every prompt-to-app builder - intent and code drift apart
      as the project grows - and nobody else solves it. The most defensible thing on this list.
- [ ] **3. Email from the generated app** (~1 day). Forms notify the owner; this notifies the person
      who submitted ("thanks, we got your booking"). Reuses the existing Resend transport.
- [ ] **4. End-user file uploads** (~1-2 days). The app backend stores JSON but not files. Unlocks
      portfolios, job applications, anything with an attachment.
- [ ] **5. Published-app analytics** (~half a day). Views per published app. Answers the first
      question every customer asks after publishing.
- [ ] **6. Custom domains for published apps** (~2 days).

Deliberately skipped: mobile via Expo, Vue/Svelte support, real-time collaboration. Weeks each,
chasing a competitor's strength instead of building our own.

### Smaller outstanding items

- [ ] **Backfill the Report badge** onto the 19 apps published before it existed (one-off script over
      the stored HTML). New publishes already carry it.
- [ ] **Automated image moderation at publish** (~1 day). Claude vision, one call per image at publish
      only, ~$0.002 each. Refuses explicit, violent or illegal content. The takedown path now exists,
      which matters more than the classifier.
- [ ] **Per-account trial cap overshoot.** `STARTER_USER_CAP` is checked before a build when spend is
      $0, so one build can exceed it (observed: $0.227 against a $0.10 cap). The $1 monthly ceiling
      still bounds total exposure. Only worth changing if the per-account number needs to be exact.

### Done since this file was written

- [x] Native Forms shipped: migration 005 applied to production, routes live, tests in `npm test`.
- [x] Forms data management: delete a form, delete a submission, clear an inbox, CSV export
      (spreadsheet formulas neutralised), manual resend of a failed notification.
- [x] Agent modes (auto/build/debug/review) shipped with tests in CI.
- [x] Customer images: hero/logo/background slots, resized and re-encoded in the browser, EXIF
      stripped, SVG refused, publish blocked if a placeholder was not substituted.
- [x] Abuse reporting and takedown: migration 007, report badge on every new publish, `/report`,
      admin queue, 451 takedown page, acceptable-use terms.
- [x] `generation_stats` now records free-trial builds (migration 006); the dashboard has a third
      series. It recorded nothing for trial builds before.
- [x] Free-trial limits tightened: 1 build, $0.10 per account, $1.00 per month, explicit kill switch.
- [x] CI runs the test suite on every push to main and every PR (PR #1).
- [x] Crawler logging: one line per search-engine or AI crawler visit in the runtime logs.
- [x] SEO: pricing page no longer duplicates the homepage, contextual internal links added, demo page
      expanded from 158 to 561 words, favicons in every size, sitemap lastmod corrected.

## 2. Highest-priority reliability and cost suggestions

- [ ] Capture actual browser, server and network errors before attempting a repair.
- [ ] Detect repeated unsuccessful repairs; stop and explain the blocker.
- [ ] Add per-task budgets, clear usage breakdowns and bounded retry counts.
- [ ] Show generation/repair estimates and distinguish estimates from actual charges.
- [ ] Enforce protected files/features and explain necessary changes outside the selected scope.
- [ ] Run regression checks on important existing behavior before accepting a change.
- [ ] Provide checkpoints, reviewable diffs and reliable rollback.
- [ ] Maintain an approved project specification and explicit active task to reduce stale-context errors.
- [ ] Link requirements to implementation and passed, failed or untested acceptance checks.
- [ ] Show a plain-language change report with supporting test evidence.
- [ ] Validate deployment configuration and live login, forms, data access and payment flows where applicable.
- [ ] Show security findings with scope, evidence and remaining untested areas; avoid blanket security guarantees.
- [ ] Measure total cost per successfully completed feature, regression rate and time to a working result.

## 3. User-selectable agents — proposed feature

Yes: users could choose a specialist based on their task, with an Auto option for users who prefer the builder to choose. Agent role and underlying LLM are separate choices. A role defines instructions, tools, permissions and expected output; a model is the engine running it.

| Proposed choice | Work it handles | Expected output |
| --- | --- | --- |
| Auto | Select an appropriate workflow for the request | A short plan, selected specialist and estimated cost |
| Product planner | Goals, user scope, PRD and acceptance criteria | Reviewable requirements |
| Technical architect | TRD, architecture and interfaces | Technical plan and implementation tasks |
| UI/UX designer | Screens, interaction flows and visual changes | Preview and interaction specifications |
| Backend builder | Schema, API, authentication and forms | Backend changes with access-control checks |
| Frontend builder | UI implementation and API integration | Working screens with interaction tests |
| Debugging and testing | Reproduce errors, fix defects and check regressions | A verified fix or an explicit unresolved blocker |
| Security reviewer | Secrets, permissions, dependencies and vulnerability checks | Findings and reviewed remediation proposals |
| Deployment and maintenance | Release checks, deployment diagnosis and incident triage | Release evidence or a proposed repair |

- [ ] Audit current generation/model selection before adding another selector.
- [ ] Start with Auto, Build, Debug and Review; expand roles after usability testing.
- [ ] Let users select the kind of product (landing page, web app, dashboard or store) separately from agent role.
- [ ] Offer task/model suitability guidance; clearly identify unsupported build targets.
- [ ] If users want provider/model choice too, define a supported-model list with current capability and price information.
- [ ] Keep provider keys on the server and make billing ownership clear if bring-your-own-key is offered.
- [ ] Use a shared versioned specification and structured handoffs between specialists.
- [ ] Enforce permissions through application controls, not prompt instructions alone.
- [ ] Bound each task by time, budget and attempts; make cancellation and failure states visible.
- [ ] Review diffs and verification evidence before accepting agent changes.
- [ ] Prototype sequential handoffs first. Evaluate parallel execution only for independent tasks, with isolated workspaces and merge checks.
- [ ] Compare quality, total cost and elapsed time against the existing single-agent flow before claiming savings.

Users can choose the specialist; we should not promise that every agent/model can build every type of software.

## 4. Six-phase guided build workflow

- [ ] Phase 1: PRD — goals, users, scope and measurable acceptance criteria.
- [ ] Phase 2: TRD — stack, architecture, dependencies and cost constraints.
- [ ] Phase 3: UX/UI — screens, navigation and interaction review.
- [ ] Phase 4: Database/backend — schema, API contracts and authorization.
- [ ] Phase 5: Frontend/testing — integration, user journeys and regression checks.
- [ ] Phase 6: Deployment/maintenance — release validation, rollback and health checks.
- [ ] Preserve approved decisions between phases and allow users to revise them with visible downstream impact.

## 5. Later research and optional enhancements

- [ ] Natural-language summaries linked to code and runtime errors; evaluate mapping accuracy after edits.
- [ ] File/symbol navigation and selective context retrieval; benchmark against vector or tree-based alternatives before choosing infrastructure.
- [ ] Production error monitoring leading to reproduced, tested repair proposals.
- [ ] Voice, sketch and visual editing inputs; validate demand before combining them.
- [ ] Domain-specific control templates and evidence collection; do not market generated code as automatic regulatory compliance.
- [ ] Forms: submission export/deletion, retention controls and configurable notification preferences.
- [ ] Forms: notification retry worker, stronger abuse controls and isolated test mode.
- [ ] Forms: uploads, webhooks, integrations and scoped MCP tools if demand justifies their cost.
- [ ] Evaluate customer demand through founder interviews and a fixed set of representative build tasks.

Supporting research and qualifications: [Competitor research](vibe-coding-research-2026-09-17.md).

## 6. Earlier SEO and blog follow-up — verify current status first

These are earlier requested areas, not confirmed new deployment blockers.

- [ ] Audit current Google Search Console homepage indexing and exact brand-query performance.
- [ ] Check canonical tags, robots directives and sitemap membership for public marketing/blog pages; decide app/dashboard indexing intentionally.
- [ ] Verify which prior SEO and blog changes are already published before repeating work.
- [ ] Retain keyword research and verify volumes, region, date range and intent from actual Keyword Planner data.
- [ ] Keep VibeSafe Builder and the VibeSafe security scanner clearly distinguished in titles, descriptions and content.
- [ ] Prioritize helpful articles about debugging loops, generation costs, deployment and AI-code security using verified sources.
- [ ] Track impressions, clicks and conversions after publication; avoid promises of specific rankings.

Suggested order when work resumes: finish the Forms pilot verification, strengthen repair/cost controls, prototype agent selection, then expand the guided workflow. Future roadmap items do not all need to ship with Forms.
