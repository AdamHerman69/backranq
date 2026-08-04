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

SMTP2GO does not currently provide a native Vercel Marketplace integration.
Connect it with a narrowly scoped API key stored in Vercel instead:

1. Create an SMTP2GO account, then open **Sending → Verified Senders → Sender
   Domains** and add the domain used in the From address. Publish the DNS records
   shown by SMTP2GO and wait until the sender domain is verified.
2. Open **Sending → API Keys**, create a dedicated `Backranq Production` key,
   and grant it only the `/email/send` permission.
3. In **Vercel project → Settings → Environment Variables**, add these
   Production variables:

   - `SMTP2GO_API_KEY=<dedicated API key from step 2>`
   - `BACKRANQ_EMAIL_FROM=Backranq <notifications@updates.example.com>`
   - `BACKRANQ_APP_URL=https://app.example.com`
   - `NOTIFICATION_UNSUBSCRIBE_SECRET=<dedicated random secret>`
   - `SMTP2GO_WEBHOOK_SECRET=<another dedicated random secret>`

   Mark secrets as sensitive. Existing `CRON_SECRET` and
   `BACKRANQ_ADMIN_API_SECRET` must also be configured.
4. Deploy the application and its notification database migration so the
   production webhook URL exists.
5. In **SMTP2GO → Settings → Webhooks → Manage Webhooks**, add:

   - URL: `https://app.example.com/api/webhooks/smtp2go`
   - Authorization: `Bearer`, with the exact value stored in
     `SMTP2GO_WEBHOOK_SECRET`
   - Output type: `JSON`
   - User: the API key created for Backranq
   - Events: `Delivered`, `Bounce`, `Spam`, `Reject`, and `Unsubscribe`

   Leave SMTP2GO's optional unsubscribe footer disabled. Backranq already adds
   its own visible link and one-click unsubscribe headers.
6. Use **Test this webhook**, then send one real practice-ready test. Confirm the
   email under SMTP2GO **Reports → Activity** and the callback in the webhook
   history.
7. Web Push is independent of SMTP2GO. If it is wanted, generate VAPID keys with
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
