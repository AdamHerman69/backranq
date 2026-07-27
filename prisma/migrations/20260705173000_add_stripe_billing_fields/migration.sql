ALTER TABLE "BillingAccount"
ADD COLUMN "stripeCustomerId" TEXT,
ADD COLUMN "stripeSubscriptionId" TEXT,
ADD COLUMN "stripeSubscriptionStatus" TEXT,
ADD COLUMN "stripePriceId" TEXT,
ADD COLUMN "stripeCurrentPeriodEnd" TIMESTAMP(3);

CREATE UNIQUE INDEX "BillingAccount_stripeCustomerId_key"
ON "BillingAccount"("stripeCustomerId");

CREATE UNIQUE INDEX "BillingAccount_stripeSubscriptionId_key"
ON "BillingAccount"("stripeSubscriptionId");

CREATE INDEX "BillingAccount_stripePriceId_idx"
ON "BillingAccount"("stripePriceId");

CREATE INDEX "BillingAccount_stripeSubscriptionStatus_idx"
ON "BillingAccount"("stripeSubscriptionStatus");
