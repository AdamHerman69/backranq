This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

Backranq supports Node.js 24. Use the version in `.nvmrc`; CI and the
production Vercel project use the same major runtime.

## Getting Started

### Environment variables

Copy `env.local.example` to `.env.local` and fill in at least `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, and whichever OAuth provider credentials you want enabled.

The runtime database URL must use the serverless pooler with
`pgbouncer=true&connection_limit=1` (or `connection_limit=2`). Keep
`DIRECT_URL` on the direct database endpoint for migrations. Operator scripts
load environment files with the same precedence as Next.js: explicit process
variables, environment-specific local values, `.env.local`, environment-specific
values, then `.env`.

For Supabase-backed local development, also set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The health endpoint reports Prisma/database health separately from Supabase REST configuration, but still fails overall when required env is missing.

The sign-in page (`/login`) only shows providers whose env vars are set (see `src/lib/auth/config.ts`).

If you want to automatically link accounts across providers by matching email (avoids `OAuthAccountNotLinked`), set `AUTH_DANGEROUS_EMAIL_LINKING=true`.

### Server analysis, billing, and queues

Server analysis is credit-backed work. Browser analysis stays free and local. Standard server analysis costs 7 credits per game; the default Thorough profile costs 10 and uses a larger adaptive confirmation frontier. Quality, exact resolved options, and price are immutable enqueue-time `AnalysisRun` provenance. If the exact reservation fails, the job is not queued.

Required billing env:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PLUS_MONTHLY`
- `STRIPE_PRICE_PRO_MONTHLY`
- `BACKRANQ_APP_URL` or `NEXTAUTH_URL`

Local Stripe smoke setup:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`. The checked-in example prices are test-mode placeholders for the provisional $2/month Plus and $6/month Pro plans.

Queue recovery is DB-led. Vercel Queue delivery is treated as a transport; retry state lives in Postgres:

- `QUEUED` analysis jobs are dispatched with per-user fairness and a lease.
- expired `RUNNING` analysis jobs are recovered by the scheduler and requeued with exponential backoff until max attempts.
- sync jobs use the same lease/retry pattern and the active provider-job partial index prevents duplicate provider work per user.
- automatic analysis enforces independent daily/monthly game limits plus the credit reserve threshold; a 7- or 10-credit run always occupies one automatic-game slot.

Admin ops endpoint:

```bash
curl -H "Authorization: Bearer $BACKRANQ_ADMIN_API_SECRET" \
  "$BACKRANQ_APP_URL/api/admin/analysis-ops"
```

The snapshot includes queue counts, stuck counts, oldest queued/running ages, recent errors, and credit ledger totals.

Premium administration is available at `/admin/premium` to active database-backed
administrators with the `PREMIUM_MANAGE` capability. Active administrators receive
Pro automatically. From the portal they can send a 14-day, single-use invitation
for permanent complimentary Pro access. The recipient must sign in with the invited
email before accepting. Invitation email uses the existing `SMTP2GO_API_KEY`,
`BACKRANQ_EMAIL_FROM`, and `BACKRANQ_APP_URL` settings.

Deployment readiness endpoint:

```bash
curl -H "Authorization: Bearer $BACKRANQ_ADMIN_API_SECRET" \
  "$BACKRANQ_APP_URL/api/admin/readiness"
```

Local smoke commands:

```bash
pnpm check:runtime
pnpm check:stripe
pnpm check:ledger
pnpm load:analysis-queue
```

`pnpm check:runtime` evaluates the same production-readiness contract as the
authorized admin endpoint. It fails closed for missing auth, database, billing,
admin, cron, queue, email, or Web Push configuration and never prints secret
values. Use `pnpm check:runtime -- --local` only to inspect a local environment
where notification transports may intentionally be disabled.

### Authenticated end-to-end tests

The Playwright suite starts an isolated PostgreSQL 17 container, applies the
checked-in Prisma migrations, builds and starts the production Next.js output,
creates a short-lived Auth.js session plus deterministic games and training
moments, and removes the container and fixture user after the run. Its child
environment disables queues and strips provider, billing, OAuth, VAPID,
Supabase service-role, and Vercel credentials. Email UI receives a deliberately
invalid E2E-only key and an `example.invalid` sender so configuration journeys
remain testable without inheriting a deliverable credential. The default suite
therefore cannot write to external services.

```bash
pnpm test:e2e:install
pnpm test:e2e
pnpm test:e2e:coach-offline
```

The second command covers the Coach and cold-offline PWA journeys against the
same production server shape. Both suites are required in CI; live provider and
live Maia model checks remain explicit opt-in jobs.

Use `pnpm test:e2e:headed` for a visible browser or `pnpm test:e2e:ui` for
Playwright UI mode. Set `BACKRANQ_E2E_KEEP_DB=true` to retain the local
container between runs.

Remote databases are never used by default, including values in
`.env.e2e.local`. A Supabase development branch can be used only with
`BACKRANQ_E2E_USE_EXTERNAL_DATABASE=true`, an E2E URL, and all safety
confirmations shown in `.env.e2e.example`, including the exact hosts from both
the pooled and direct URLs. The wrapper validates these and verifies that both
URLs identify the same disposable database/project before applying migrations.
Never point these variables at the production project.

Migrations:

```bash
pnpm db:migrate:deploy
```

The migration wrapper loads `.env.local`, verifies that pooled and direct URLs
identify the same database, prints only a redacted target fingerprint, enforces
a bounded timeout, and propagates every Prisma failure. It also verifies the
migration status after deployment; it never continues after a timeout or error.

For a local billing smoke, create a session only in a loopback database whose
name ends in `local`, `test`, or `e2e`:

```bash
pnpm smoke:auth-session
```

The command accepts only a dedicated `@backranq.local` identity and writes the
short-lived credential to the gitignored `.backranq-local` directory with
owner-only permissions. Pass `--print-cookie` only when a local command truly
needs the raw cookie in the terminal.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
