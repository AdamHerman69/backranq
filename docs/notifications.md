# Notifications and email

Backranq stores every user-facing notification in PostgreSQL. Email and Web
Push are delivery channels for that durable inbox, not the source of truth.
Creating a notification and its pending delivery happens in the same database
transaction as the product event whenever the event already has a transaction
(for example analysis completion and game sync completion).

## Supported events

- New Practice positions after analysis, combined into at most one daily email
  at the user's chosen digest hour and timezone.
- New games imported by automatic sync, with off/daily/weekly email options.
- Terminal analysis and sync failures.
- Automatic analysis paused at the configured credit reserve and failed Stripe
  invoices.
- Welcome message for newly created OAuth users.
- Opt-in weekly progress summaries.
- Explicitly opted-in product-news campaigns.

Transactional, optional digest, and marketing preferences are separate.
Product news records a consent timestamp. The unsubscribe endpoint disables all
optional email categories, including practice-ready messages. Practice-ready
email is also marked as low priority for clients that honor importance headers.
It is not sent as Web Push, so it remains a quiet inbox and daily-email update.
Analysis and sync failures stay in the in-app inbox by default; payment failures
and automatic analysis stopping at the configured credit reserve remain enabled
as important email alerts.

## Provider setup

1. In Resend, add a dedicated sending subdomain such as
   `updates.example.com`. Add the SPF and DKIM records shown by Resend to DNS
   and wait until the domain is verified. DMARC is recommended as a follow-up.
2. In the Vercel project, install the Resend Marketplace integration. It creates
   `RESEND_API_KEY`. Alternatively, create a sending API key in Resend and add
   it manually under **Project → Settings → Environment Variables**.
3. Add these Production environment variables in Vercel:

   - `BACKRANQ_EMAIL_FROM=Backranq <notifications@updates.example.com>`
   - `BACKRANQ_APP_URL=https://app.example.com`
   - `NOTIFICATION_UNSUBSCRIBE_SECRET=<dedicated random secret>`
   - `RESEND_WEBHOOK_SECRET=<copied in step 5>`

   Mark secrets as sensitive. Existing `CRON_SECRET` and
   `BACKRANQ_ADMIN_API_SECRET` must also be configured.
4. Deploy the application and its notification database migration so the
   production webhook URL exists.
5. In **Resend → Webhooks → Add Webhook**, register
   `https://app.example.com/api/webhooks/resend` and select
   `email.delivered`, `email.bounced`, `email.complained`,
   `email.suppressed`, and `email.failed`. Copy its signing secret into
   `RESEND_WEBHOOK_SECRET` in Vercel, then redeploy because environment-variable
   changes apply only to new deployments.
6. Send one real practice-ready test and confirm the email in Resend Events and
   the webhook request in the Webhooks event list.
7. Web Push is independent of Resend. If it is wanted, generate VAPID keys with
   `pnpm exec web-push generate-vapid-keys` and set the three VAPID variables
   from `env.local.example`.

For local development, put the same values in the uncommitted `.env.local`
file. Never commit API keys or signing secrets.

Templates use the unified React Email 6 `react-email` package rather than the
deprecated `@react-email/components` package.

Email and push deliveries remain `PENDING` when their provider configuration is
absent. This makes local development safe and allows delivery after production
configuration is completed.

## Processing

The hourly `/api/cron/notifications` job creates due weekly summaries and wakes
pending deliveries. Vercel Queue processes each delivery independently. The
database claim lease and provider idempotency key make retries safe. Delivery
webhooks update final status and suppress future email after a bounce, spam
complaint, or provider suppression.

The same hourly job reconciles recent terminal analysis/sync jobs and newly
created users into deduplicated notifications. This repairs the outbox if a
post-transition event write failed without making notification availability a
precondition for login or for reporting completed core work.

## Product-news API

`POST /api/admin/notifications/news` requires
`Authorization: Bearer $BACKRANQ_ADMIN_API_SECRET` and accepts:

```json
{
  "campaignId": "practice-redesign-2026-08",
  "title": "A better Practice session",
  "body": "Practice now adapts more closely to your recent games.",
  "href": "/practice",
  "cursor": null
}
```

Every user receives the announcement in the in-app inbox. Email delivery is
created only for users with explicit product-news consent. A request processes
at most 500 users and returns `nextCursor` when another request is required. The
campaign ID is part of the deduplication key, so retrying the same page does not
create duplicate notifications.
