# VibeSafe Builder

[![CI](https://github.com/SabahatGhauri/vibesafe-builder/actions/workflows/ci.yml/badge.svg)](https://github.com/SabahatGhauri/vibesafe-builder/actions/workflows/ci.yml)

**An AI app builder: describe an app in plain English and it writes a working one.**
The difference: other AI app builders bill you for their mistakes. This one shows every cost
before you spend it, makes every change reversible, and scans every build before you publish.

**Live at [vibesafebuilder.com](https://vibesafebuilder.com)** ·
[Interactive demo](https://vibesafebuilder.com/demo.html) (no account needed) ·
[Pricing](https://vibesafebuilder.com/pricing.html) ·
[How it works](https://vibesafebuilder.com/how-it-works.html)

---

## What it does

- **Cost estimate before every generation**, plus a spend cap you set yourself
- **Failed generations never count** toward your build spend
- **Breaks fix loops automatically** — after two failed fixes on the same problem, it re-diagnoses
  and takes a different approach instead of repeating itself
- **Full version history** with diffs and one-click rollback
- **Security scan on every build** — blocks publishing on critical findings such as leaked keys,
  plus a real-browser Launch Check
- **Apps you own** — download a single file and host it anywhere, or sync a project to GitHub and
  deploy to Vercel
- **15 free templates** to start from

## Plans

| Plan | Price | |
|---|---|---|
| Bring your own key | $0/month platform fee | Use your own Anthropic key, billed by Anthropic with no markup |
| Managed | $15/month | No API key needed, $10/month of usage included, pauses at the cap — never an overage charge |

## Free resource

**[The AI App Builder Checklist](https://github.com/SabahatGhauri/ai-app-builder-checklist)** —
25 checks for building with any AI tool: control credit spend, avoid fix loops, publish safely.

---

VibeSafe Builder is a product of [SG Digital Ventures LLC](https://sgdigitalventures.com).
It is a separate product from [VibeSafe](https://vibesafe.info), the AI code security scanner.

Questions: [contact@vibesafebuilder.com](mailto:contact@vibesafebuilder.com)

## Development

Use **Node.js 22** (the version in `package.json`).

```sh
npm ci --ignore-scripts
npm test
npm start
```

The local server listens at http://localhost:3111. Without service credentials, you can inspect public pages; authentication, generation, billing, and publishing need their respective services configured. This repository runs directly in Node.js and has no build script.

Configuration comes from the shell environment. For a local file, create an untracked `.env.local` and run `node --env-file=.env.local server.js`; `npm start` does not load that file automatically.

| Variables | Purpose |
| --- | --- |
| `SITE_URL`, `PORT` | Set `SITE_URL=http://localhost:3111` for local development; port defaults to 3111. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Dedicated development database and authentication; provision `db/schema.sql` and review `db/migrations/`. Keep the service-role key on the server. |
| `ANTHROPIC_API_KEY` | Server-funded generation; calls can incur usage charges. |
| `APP_BACKEND_TOKEN_SECRET` | Server-side signing secret for generated-app backend tokens. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | Billing; use Stripe test credentials during development. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN_SECRET` | Optional GitHub OAuth and token encryption. |
| `RESEND_API_KEY` | Optional transactional email. |
| `CHROME_PATH` | Local Chrome executable for browser-based Launch Checks. |

### Tests and CI

`npm test` runs the existing unit and mocked route tests without production credentials. GitHub Actions runs that command on pushes and pull requests using Node 22. It does not deploy the app.

Database integration tests are separate. Create a dedicated Supabase test project, provision `db/schema.sql`, and set `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, and `TEST_SUPABASE_SERVICE_ROLE_KEY` in the shell or untracked `.env.test`. Then run `npm run test:integration`. These tests write and clean up test records; they skip when test credentials are absent. Never point them at production.

### Code map

- `server.js`: local entry point; `api/index.js`: Vercel entry point.
- `lib/app.js`: shared Express application; other `lib/` modules implement backend services.
- `public/`: browser assets and public pages.
- `db/`: database schema and migrations; `test/`: automated checks.

For vulnerabilities, see [SECURITY.md](SECURITY.md).
