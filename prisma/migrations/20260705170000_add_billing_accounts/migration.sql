-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('FREE', 'PLUS', 'PRO');

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "plan" "BillingPlan" NOT NULL DEFAULT 'FREE',
    "serverCreditsBalance" INTEGER NOT NULL DEFAULT 100,
    "monthlyServerCreditsUsed" INTEGER NOT NULL DEFAULT 0,
    "serverCreditsRenewAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 month'),
    "monthlyServerCreditsLimit" INTEGER NOT NULL DEFAULT 100,
    "autoAnalysisMonthlyCap" INTEGER NOT NULL DEFAULT 50,
    "autoAnalysisDailyCap" INTEGER NOT NULL DEFAULT 10,
    "stopWhenCreditsBelow" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingAccount_serverCreditsBalance_nonnegative_check" CHECK ("serverCreditsBalance" >= 0),
    CONSTRAINT "BillingAccount_monthlyServerCreditsUsed_nonnegative_check" CHECK ("monthlyServerCreditsUsed" >= 0),
    CONSTRAINT "BillingAccount_monthlyServerCreditsLimit_nonnegative_check" CHECK ("monthlyServerCreditsLimit" >= 0),
    CONSTRAINT "BillingAccount_autoAnalysisMonthlyCap_nonnegative_check" CHECK ("autoAnalysisMonthlyCap" >= 0),
    CONSTRAINT "BillingAccount_autoAnalysisDailyCap_nonnegative_check" CHECK ("autoAnalysisDailyCap" >= 0),
    CONSTRAINT "BillingAccount_stopWhenCreditsBelow_nonnegative_check" CHECK ("stopWhenCreditsBelow" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_userId_key" ON "BillingAccount"("userId");

-- CreateIndex
CREATE INDEX "BillingAccount_plan_idx" ON "BillingAccount"("plan");

-- CreateIndex
CREATE INDEX "BillingAccount_serverCreditsRenewAt_idx" ON "BillingAccount"("serverCreditsRenewAt");

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
