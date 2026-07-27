This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### Environment variables

Copy `env.local.example` to `.env.local` and fill in at least `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, and whichever OAuth provider credentials you want enabled.

For Supabase-backed local development, also set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The health endpoint reports Prisma/database health separately from Supabase REST configuration, but still fails overall when required env is missing.

The sign-in page (`/login`) only shows providers whose env vars are set (see `src/lib/auth/config.ts`).

If you want to automatically link accounts across providers by matching email (avoids `OAuthAccountNotLinked`), set `AUTH_DANGEROUS_EMAIL_LINKING=true`.

### Server analysis, billing, and queues

Server analysis is credit-backed work. Browser analysis stays free and local; server analysis creates `AnalysisJob`, `AnalysisRun`, and `CreditLedgerEntry` records in one serializable transaction. If credit reservation fails, the job is not queued.

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
- automatic analysis enforces daily/monthly auto caps plus the stop-when-credits-below threshold.

Admin ops endpoint:

```bash
curl -H "Authorization: Bearer $BACKRANQ_ADMIN_API_SECRET" \
  "$BACKRANQ_APP_URL/api/admin/analysis-ops"
```

The snapshot includes queue counts, stuck counts, oldest queued/running ages, recent errors, and credit ledger totals.

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

Migrations:

```bash
pnpm prisma migrate deploy
```

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
