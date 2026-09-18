# VibeSafe Builder: suggestions and deployment checklist

Updated: 17 September 2026.

This is a planning checklist, not authorization to implement or deploy every item. Forms work is paused. Unchecked items are proposals or outstanding checks, not claims that the current product lacks every listed capability. Audit existing features before implementing duplicates.

## 1. Native Forms: work remaining before deployment

Current state: contact/waitlist forms, private inbox, optional notification emails, basic spam controls, quotas and build-prompt integration are implemented locally and uncommitted. Previous verification: 12 new backend tests and 286 existing tests passed. Database and browser end-to-end verification remain outstanding.

- [ ] Review the complete pending diff and confirm the pilot scope.
- [ ] Execute migration `005_native_forms.sql` on a dedicated test database.
- [ ] Verify database permissions and owner isolation using real database roles.
- [ ] Verify concurrent submission limits, monthly quotas and paused-form behavior against PostgreSQL.
- [ ] Test Forms UI on desktop and mobile: create, select, copy, pause/resume and inbox refresh.
- [ ] Test the full generated-form flow in preview and on the isolated published-app domain, including CSP/CORS behavior.
- [ ] Test notifications to an owned test address and confirm failed email does not lose a submission.
- [ ] Verify production database, mail sender and canonical SITE_URL configuration without exposing secrets.
- [ ] Define pilot retention/full-inbox handling and notification-failure support procedures.
- [ ] Add forms tests to the standard CI test command and run relevant release checks.
- [ ] Prepare a compatible rollback and migration recovery plan that preserves submitted data.
- [ ] Commit and push the reviewed changes when release work resumes.
- [ ] Apply the production migration before enabling the application routes/UI.
- [ ] Deploy to Vercel and verify the actual deployed version.
- [ ] Run an authorized production smoke check and inspect errors and email delivery.

Details: [Native Forms](native-forms.md).

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
