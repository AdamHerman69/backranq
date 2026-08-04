-- Backranq is pre-user. Replace the obsolete one-credit queue contract rather
-- than translating in-flight reservations or legacy engine preferences.
DELETE FROM "TrainingMoment";
DELETE FROM "CreditLedgerEntry";
DELETE FROM "AnalysisJob";
DELETE FROM "AnalysisRun";

UPDATE "AnalyzedGame"
SET "analysis" = '{}'::jsonb,
    "analyzedAt" = NULL,
    "currentAnalysisRunId" = NULL,
    "currentAnalysisValid" = false;

UPDATE "BillingAccount"
SET "serverCreditsBalance" = CASE "plan"
        WHEN 'PRO' THEN 5000
        WHEN 'PLUS' THEN 1000
        ELSE 100
    END,
    "monthlyServerCreditsLimit" = CASE "plan"
        WHEN 'PRO' THEN 5000
        WHEN 'PLUS' THEN 1000
        ELSE 100
    END,
    "monthlyServerCreditsUsed" = 0;

UPDATE "User"
SET "preferences" =
    (("preferences"
        - 'analysisNodesPerPosition'
        - 'confirmationNodes'
        - 'themeLookaheadPlies')
        #- '{gameAutomation,analysis,dailyCap}'
        #- '{gameAutomation,analysis,monthlyCap}'
        #- '{gameAutomation,analysis,reserveCredits}');

CREATE TYPE "AnalysisQuality" AS ENUM ('STANDARD', 'THOROUGH');

ALTER TABLE "AnalysisRun"
    ADD COLUMN "analysisQuality" "AnalysisQuality" NOT NULL DEFAULT 'THOROUGH',
    ADD COLUMN "creditCost" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AnalysisRun"
    ALTER COLUMN "analysisQuality" DROP DEFAULT,
    ALTER COLUMN "creditCost" DROP DEFAULT,
    ADD CONSTRAINT "AnalysisRun_creditCost_nonnegative_check"
        CHECK ("creditCost" >= 0),
    ADD CONSTRAINT "AnalysisRun_consumedCredits_nonnegative_check"
        CHECK ("consumedCredits" IS NULL OR "consumedCredits" >= 0),
    ADD CONSTRAINT "AnalysisRun_quality_credit_contract_check"
        CHECK (
            ("executionMode" = 'SERVER_QUEUE'
                AND "analysisQuality" = 'STANDARD'
                AND "creditCost" = 7)
            OR
            ("executionMode" = 'SERVER_QUEUE'
                AND "analysisQuality" = 'THOROUGH'
                AND "creditCost" = 10)
            OR
            ("executionMode" <> 'SERVER_QUEUE' AND "creditCost" = 0)
        );

ALTER TABLE "AnalysisJob" DROP COLUMN "estimatedCredits";

ALTER TABLE "BillingAccount"
    DROP COLUMN "autoAnalysisMonthlyCap",
    DROP COLUMN "autoAnalysisDailyCap",
    ADD COLUMN "serverCreditsPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "autoAnalysisMonthlyGameLimit" INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN "autoAnalysisDailyGameLimit" INTEGER NOT NULL DEFAULT 10,
    ADD CONSTRAINT "BillingAccount_autoAnalysisMonthlyGameLimit_nonnegative_check"
        CHECK ("autoAnalysisMonthlyGameLimit" >= 0),
    ADD CONSTRAINT "BillingAccount_autoAnalysisDailyGameLimit_nonnegative_check"
        CHECK ("autoAnalysisDailyGameLimit" >= 0);

UPDATE "BillingAccount"
SET "serverCreditsPeriodStart" = CURRENT_TIMESTAMP,
    "serverCreditsRenewAt" = CURRENT_TIMESTAMP + INTERVAL '1 month';

UPDATE "BillingAccount"
SET "autoAnalysisMonthlyGameLimit" = CASE "plan"
        WHEN 'PRO' THEN 5000
        WHEN 'PLUS' THEN 500
        ELSE 50
    END,
    "autoAnalysisDailyGameLimit" = CASE "plan"
        WHEN 'PRO' THEN 250
        WHEN 'PLUS' THEN 50
        ELSE 10
    END;
