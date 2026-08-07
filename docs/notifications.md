# Notifications and email

Backranq stores every user-facing notification in PostgreSQL. Email and Web
Push are delivery channels for that durable inbox, not the source of truth.
Creating a notification and its pending delivery happens in the same database
transaction as the product event whenever the event already has a transaction
(for example analysis completion and game sync completion).

## Supported events

- New Practice positions after analysis, combined into at most one daily email
  at the user's chosen digest hour and timezone.
- Scheduled Practice reviews derived from the current, verified solution
  semantics. Outstanding reviews may create one reminder per local digest day;
  retries replace the same daily snapshot instead of inflating its count. A
  bounded live recheck cancels the delivery when it can prove the queue is
  empty. If that check exhausts its raw-row budget on stale state, the durable
  sweep snapshot is preserved rather than misreporting an unknown result as
  zero.
- New games imported by automatic sync, with off/daily/weekly email options.
- Terminal analysis and sync failures.
- Automatic analysis paused at the configured credit reserve and failed Stripe
  invoices.
- Welcome message for newly created OAuth users.
- Opt-in weekly progress summaries.
- Explicitly opted-in product-news campaigns.

Transactional, optional digest, and marketing preferences are separate.
Product news records a consent timestamp. The unsubscribe endpoint disables all
optional email categories, including practice-ready and practice-due messages.
Both Practice email types share the user's `emailPracticeReady` preference and
the same local-calendar daily-send guard. They are marked low priority for mail
clients that honor importance headers. Due reminders may also use Web Push when
the user has explicitly enabled push; creation notifications remain email-only.
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
   - `SMTP2GO_DAILY_SEND_LIMIT=30`
   - `SMTP2GO_EMAILS_PER_DISPATCH=20`
   - `SMTP2GO_TRANSACTIONAL_RESERVE=5`

   Mark secrets as sensitive. Existing `CRON_SECRET` and
   `BACKRANQ_ADMIN_API_SECRET` must also be configured.
4. Apply the additive production migration with `pnpm db:migrate:deploy`
   **before** promoting or deploying application code that uses notifications.
   The Vercel build does not run migrations. Then deploy the application so the
   production webhook URL exists.
5. In **SMTP2GO → Settings → Webhooks → Manage Webhooks**, add:

   - URL: `https://app.example.com/api/webhooks/smtp2go`
   - Authorization: `Bearer`, with the exact value stored in
     `SMTP2GO_WEBHOOK_SECRET`
   - Output type: `JSON`
   - User: the API key created for Backranq
   - Events: `Delivered`, `Bounce`, `Spam`, `Reject`, and `Unsubscribe`
   - Email headers: `X-Backranq-Delivery-Id`

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

Premium invitations are transactional emails initiated from `/admin`. The
database stores only a hash of the 14-day token. A link does not grant access by
itself: after sign-in, the recipient must explicitly accept it from the same
normalized email address. Resending a confirmed `SENT` invitation rotates the
token and invalidates the old link; a failed or ambiguous provider attempt
reuses the same generation so a possibly delivered link remains valid. These
emails are not governed by optional notification preferences or unsubscribe
state, but they reserve from the same SMTP2GO safety budget as notification
email and cannot consume the slots reserved for billing-action messages.

Email and push deliveries remain `PENDING` when their provider configuration is
absent. This makes local development safe and allows delivery after production
configuration is completed.

## Processing

The daily `/api/cron/notifications` job is a reconciliation fallback that
creates Practice-due reminders and due weekly summaries, then wakes pending
deliveries within the Hobby cron limit. Normal future delivery times schedule a
delayed Vercel Queue sweep, so
timezone-based digest hours do not wait for the next daily cron. Vercel Queue
processes each delivery independently. The
database claim lease prevents normal concurrent retries. SMTP2GO does not offer
a provider idempotency key for this endpoint, so any email whose request times
out or loses its response is marked failed instead of retried and risking a
duplicate. Explicit quota responses are deferred until the next UTC day. The
configurable daily safety limit (30 by default, leaving headroom under the free
monthly allowance) is an atomic provider-day counter shared by notifications
and Premium invitations. The per-dispatch cap (20 by default) paces queue
traffic. Five daily slots are reserved for billing-action messages, which are
selected ahead of optional campaigns. Practice email also atomically claims one
unique local-calendar-day send window per user before provider handoff, so
concurrent ready/due workers cannot both send. A fixed-size, index-ordered
recovery pass releases only expired `RESERVED` claims left by a crash before
provider handoff; `HANDOFF` and `AMBIGUOUS` evidence is never reclaimed
automatically. Delivery webhooks use both
SMTP2GO's email ID and the requested `X-Backranq-Delivery-Id` callback field,
apply monotonic status precedence, and suppress future email after a hard bounce
or spam complaint.

Practice-due discovery is a durable snapshot sweep. Each queue message scans at
most 256 raw review-state rows by the `(nextDueAt, id)` index before applying
current-solution and VERIFIED checks. Only after the raw cursor reaches the end
does notification fan-out begin, in pages of 50 users with five concurrent
writes. Counts above 100 are displayed as `100+`. Completed sweep snapshots are
removed in bounded pages after 30 days; active scans and notification fan-outs
are never eligible for cleanup. Maintenance resumes the single active sweep
before creating a newer snapshot, so an exhausted queue retry cannot accumulate
abandoned active sweeps.

The same daily fallback job reconciles recent terminal analysis/sync jobs and newly
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
