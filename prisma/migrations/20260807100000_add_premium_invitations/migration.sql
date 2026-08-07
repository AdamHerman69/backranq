CREATE TYPE "BillingPlanSource" AS ENUM ('FREE', 'STRIPE', 'ADMIN', 'COMPLIMENTARY');
CREATE TYPE "PlanGrantSource" AS ENUM ('ADMIN_INVITATION');

ALTER TABLE "BillingAccount"
ADD COLUMN "planSource" "BillingPlanSource" NOT NULL DEFAULT 'FREE',
ADD COLUMN "stripePlan" "BillingPlan" NOT NULL DEFAULT 'FREE';

UPDATE "BillingAccount"
SET
    "stripePlan" = CASE
        WHEN "stripeSubscriptionStatus" IN ('active', 'trialing') THEN "plan"
        ELSE 'FREE'::"BillingPlan"
    END,
    "planSource" = CASE
        WHEN "stripeSubscriptionStatus" IN ('active', 'trialing') THEN 'STRIPE'::"BillingPlanSource"
        ELSE 'FREE'::"BillingPlanSource"
    END;

CREATE TABLE "PremiumInvitation" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "activeKey" TEXT,
    "tokenHash" TEXT NOT NULL,
    "plan" "BillingPlan" NOT NULL DEFAULT 'PRO',
    "invitedById" UUID NOT NULL,
    "acceptedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "providerEmailId" TEXT,
    "lastEmailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PremiumInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanGrant" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "plan" "BillingPlan" NOT NULL,
    "source" "PlanGrantSource" NOT NULL DEFAULT 'ADMIN_INVITATION',
    "invitationId" UUID,
    "grantedById" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PremiumInvitation_activeKey_key" ON "PremiumInvitation"("activeKey");
CREATE UNIQUE INDEX "PremiumInvitation_tokenHash_key" ON "PremiumInvitation"("tokenHash");
CREATE INDEX "PremiumInvitation_emailNormalized_createdAt_idx" ON "PremiumInvitation"("emailNormalized", "createdAt");
CREATE INDEX "PremiumInvitation_expiresAt_idx" ON "PremiumInvitation"("expiresAt");
CREATE INDEX "PremiumInvitation_invitedById_idx" ON "PremiumInvitation"("invitedById");
CREATE INDEX "PremiumInvitation_acceptedById_idx" ON "PremiumInvitation"("acceptedById");

CREATE UNIQUE INDEX "PlanGrant_invitationId_key" ON "PlanGrant"("invitationId");
CREATE INDEX "PlanGrant_userId_revokedAt_startsAt_expiresAt_idx" ON "PlanGrant"("userId", "revokedAt", "startsAt", "expiresAt");
CREATE INDEX "PlanGrant_grantedById_idx" ON "PlanGrant"("grantedById");

CREATE INDEX "BillingAccount_planSource_idx" ON "BillingAccount"("planSource");
CREATE INDEX "BillingAccount_stripePlan_idx" ON "BillingAccount"("stripePlan");

ALTER TABLE "PremiumInvitation" ADD CONSTRAINT "PremiumInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PremiumInvitation" ADD CONSTRAINT "PremiumInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "PremiumInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Premium grants and invitation tokens are private server-side data. They are
-- never read or written through the Supabase Data API.
ALTER TABLE public."PremiumInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlanGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PremiumInvitation" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."PlanGrant" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PremiumInvitation" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PlanGrant" FROM anon, authenticated;
