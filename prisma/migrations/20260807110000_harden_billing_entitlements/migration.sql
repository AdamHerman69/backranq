CREATE TYPE "CreditLedgerEntryScope" AS ENUM ('ALLOWANCE', 'RESERVATION');

ALTER TABLE "BillingAccount"
ADD COLUMN "stripeCurrentPeriodStart" TIMESTAMP(3),
ADD COLUMN "stripeCheckoutReservationId" TEXT,
ADD COLUMN "stripeCheckoutSessionId" TEXT,
ADD COLUMN "stripeCheckoutPlan" "BillingPlan",
ADD COLUMN "stripeCheckoutExpiresAt" TIMESTAMP(3),
ADD COLUMN "stripeCheckoutFencePlan" "BillingPlan",
ADD COLUMN "stripeCheckoutFenceSource" "BillingPlanSource";

CREATE UNIQUE INDEX "BillingAccount_stripeCheckoutReservationId_key"
ON "BillingAccount"("stripeCheckoutReservationId");
CREATE UNIQUE INDEX "BillingAccount_stripeCheckoutSessionId_key"
ON "BillingAccount"("stripeCheckoutSessionId");

ALTER TABLE "CreditLedgerEntry"
ADD COLUMN "scope" "CreditLedgerEntryScope" NOT NULL DEFAULT 'RESERVATION',
ADD COLUMN "billingPeriodStart" TIMESTAMP(3);

CREATE INDEX "CreditLedgerEntry_userId_scope_createdAt_idx"
ON "CreditLedgerEntry"("userId", "scope", "createdAt");
CREATE INDEX "CreditLedgerEntry_userId_scope_billingPeriodStart_type_idx"
ON "CreditLedgerEntry"("userId", "scope", "billingPeriodStart", "type");

-- The previous runtime stored Stripe's exact period start in the server-credit
-- anchor. Preserve that timestamp instead of trying to reconstruct it with
-- calendar arithmetic (which is incorrect for trials and month-end clipping).
UPDATE "BillingAccount"
SET "stripeCurrentPeriodStart" = "serverCreditsPeriodStart"
WHERE "stripeSubscriptionStatus" IN ('active', 'trialing')
  AND "stripeCurrentPeriodEnd" IS NOT NULL
  AND "serverCreditsPeriodStart" < "stripeCurrentPeriodEnd"
  AND "stripeCurrentPeriodStart" IS NULL;

UPDATE "BillingAccount"
SET "serverCreditsPeriodStart" = "stripeCurrentPeriodStart",
    "serverCreditsRenewAt" = "stripeCurrentPeriodEnd"
WHERE "stripeSubscriptionStatus" IN ('active', 'trialing')
  AND "stripeCurrentPeriodStart" IS NOT NULL
  AND "stripeCurrentPeriodEnd" IS NOT NULL;

-- Existing reservation events belong to the allowance period in which they
-- were created. Normalize them before reconciling balances so outstanding
-- reservations are included in the same invariant as the runtime service.
UPDATE "CreditLedgerEntry" cle
SET "billingPeriodStart" = CASE
    WHEN cle."createdAt" >= ba."serverCreditsPeriodStart"
        THEN ba."serverCreditsPeriodStart"
    ELSE date_trunc('month', cle."createdAt")
END
FROM "BillingAccount" ba
WHERE cle."userId" = ba."userId"
  AND cle."scope" = 'RESERVATION';

UPDATE "CreditLedgerEntry"
SET "billingPeriodStart" = date_trunc('month', "createdAt")
WHERE "billingPeriodStart" IS NULL;

ALTER TABLE "CreditLedgerEntry"
ALTER COLUMN "billingPeriodStart" SET NOT NULL;

-- Materialize billing rows for every entitlement holder. This makes an active
-- administrator or complimentary grant effective before the first settings or
-- capacity request, while the application reconciliation remains authoritative.
INSERT INTO "BillingAccount" (
    "userId", "plan", "planSource", "stripePlan",
    "serverCreditsBalance", "monthlyServerCreditsUsed",
    "serverCreditsPeriodStart", "serverCreditsRenewAt",
    "monthlyServerCreditsLimit", "autoAnalysisMonthlyGameLimit",
    "autoAnalysisDailyGameLimit", "stopWhenCreditsBelow",
    "createdAt", "updatedAt"
)
SELECT DISTINCT entitled."userId",
    'FREE'::"BillingPlan",
    'FREE'::"BillingPlanSource",
    'FREE'::"BillingPlan",
    100, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 month',
    100, 50, 10, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
    SELECT "userId" FROM "AdminMembership" WHERE "active" = TRUE
    UNION
    SELECT "userId" FROM "PlanGrant"
    WHERE "revokedAt" IS NULL
      AND "startsAt" <= CURRENT_TIMESTAMP
      AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
) entitled
ON CONFLICT ("userId") DO NOTHING;

WITH candidates AS (
    SELECT ba."userId", 'FREE'::"BillingPlan" AS plan,
           'FREE'::"BillingPlanSource" AS source, 0 AS plan_rank, 0 AS source_rank
    FROM "BillingAccount" ba
    UNION ALL
    SELECT ba."userId", ba."stripePlan", 'STRIPE'::"BillingPlanSource",
           CASE ba."stripePlan" WHEN 'PRO' THEN 2 WHEN 'PLUS' THEN 1 ELSE 0 END, 1
    FROM "BillingAccount" ba
    WHERE ba."stripePlan" <> 'FREE'
      AND ba."stripeSubscriptionStatus" IN ('active', 'trialing')
    UNION ALL
    SELECT pg."userId", pg."plan", 'COMPLIMENTARY'::"BillingPlanSource",
           CASE pg."plan" WHEN 'PRO' THEN 2 WHEN 'PLUS' THEN 1 ELSE 0 END, 2
    FROM "PlanGrant" pg
    WHERE pg."plan" <> 'FREE'
      AND pg."revokedAt" IS NULL
      AND pg."startsAt" <= CURRENT_TIMESTAMP
      AND (pg."expiresAt" IS NULL OR pg."expiresAt" > CURRENT_TIMESTAMP)
    UNION ALL
    SELECT am."userId", 'PRO'::"BillingPlan", 'ADMIN'::"BillingPlanSource", 2, 3
    FROM "AdminMembership" am
    WHERE am."active" = TRUE
), effective AS (
    SELECT DISTINCT ON ("userId") "userId", plan, source
    FROM candidates
    ORDER BY "userId", plan_rank DESC, source_rank DESC
), targets AS (
    SELECT e."userId", e.plan, e.source,
        CASE e.plan WHEN 'PRO' THEN 5000 WHEN 'PLUS' THEN 1000 ELSE 100 END AS credit_limit,
        CASE e.plan WHEN 'PRO' THEN 5000 WHEN 'PLUS' THEN 500 ELSE 50 END AS monthly_games,
        CASE e.plan WHEN 'PRO' THEN 250 WHEN 'PLUS' THEN 50 ELSE 10 END AS daily_games
    FROM effective e
), outstanding AS (
    SELECT ba."userId",
        LEAST(
            5000,
            GREATEST(
                0,
                COALESCE(SUM(
                    CASE cle."type"
                        WHEN 'RESERVED' THEN cle."credits"
                        WHEN 'CONSUMED' THEN -cle."credits"
                        WHEN 'RELEASED' THEN -cle."credits"
                        WHEN 'EXPIRED' THEN -cle."credits"
                        ELSE 0
                    END
                ), 0)
            )
        )::INTEGER AS credits
    FROM "BillingAccount" ba
    LEFT JOIN "CreditLedgerEntry" cle
      ON cle."userId" = ba."userId"
     AND cle."scope" = 'RESERVATION'
     AND cle."billingPeriodStart" = ba."serverCreditsPeriodStart"
    GROUP BY ba."userId"
)
UPDATE "BillingAccount" ba
SET "plan" = t.plan,
    "planSource" = t.source,
    "serverCreditsBalance" = LEAST(
        GREATEST(
            0,
            t.credit_limit - ba."monthlyServerCreditsUsed" - o.credits
        ),
        ba."serverCreditsBalance" + GREATEST(0, t.credit_limit - ba."monthlyServerCreditsLimit")
    ),
    "monthlyServerCreditsLimit" = t.credit_limit,
    "autoAnalysisMonthlyGameLimit" = t.monthly_games,
    "autoAnalysisDailyGameLimit" = t.daily_games,
    "stopWhenCreditsBelow" = 0,
    "updatedAt" = CURRENT_TIMESTAMP
FROM targets t
JOIN outstanding o ON o."userId" = t."userId"
WHERE ba."userId" = t."userId";

ALTER TABLE "CreditLedgerEntry"
ADD CONSTRAINT "CreditLedgerEntry_scope_type_check" CHECK (
    ("scope" = 'ALLOWANCE' AND "type" IN ('ALLOWANCE_GRANTED', 'ALLOWANCE_EXPIRED'))
    OR
    ("scope" = 'RESERVATION' AND "type" IN ('RESERVED', 'CONSUMED', 'REFUNDED', 'RELEASED', 'EXPIRED'))
);

ALTER TABLE "BillingAccount"
ADD CONSTRAINT "BillingAccount_stripe_period_order_check" CHECK (
    "stripeCurrentPeriodStart" IS NULL
    OR "stripeCurrentPeriodEnd" IS NULL
    OR "stripeCurrentPeriodStart" < "stripeCurrentPeriodEnd"
),
ADD CONSTRAINT "BillingAccount_checkout_reservation_shape_check" CHECK (
    (
        "stripeCheckoutReservationId" IS NULL
        AND "stripeCheckoutSessionId" IS NULL
        AND "stripeCheckoutPlan" IS NULL
        AND "stripeCheckoutExpiresAt" IS NULL
        AND "stripeCheckoutFencePlan" IS NULL
        AND "stripeCheckoutFenceSource" IS NULL
    )
    OR
    (
        "stripeCheckoutReservationId" IS NOT NULL
        AND "stripeCheckoutPlan" IS NOT NULL
        AND "stripeCheckoutExpiresAt" IS NOT NULL
        AND "stripeCheckoutFencePlan" IS NOT NULL
        AND "stripeCheckoutFenceSource" IS NOT NULL
    )
);

INSERT INTO "CreditLedgerEntry" (
    "userId", "type", "scope", "billingPeriodStart", "credits",
    "idempotencyKey", "reason", "metadata", "createdAt"
)
SELECT ba."userId", 'ALLOWANCE_GRANTED', 'ALLOWANCE',
       ba."serverCreditsPeriodStart", ba."monthlyServerCreditsLimit",
       'allowance:backfill:' || ba."userId"::text || ':' ||
           floor(extract(epoch FROM ba."serverCreditsPeriodStart") * 1000)::bigint::text,
       'billing-entitlement-backfill',
       jsonb_build_object('plan', ba."plan", 'source', ba."planSource"),
       CURRENT_TIMESTAMP
FROM "BillingAccount" ba
WHERE ba."monthlyServerCreditsLimit" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;
