import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260804120000_analysis_quality_contract/migration.sql'
);

describe('analysis quality contract migration', () => {
    it('clears every incompatible analysis and training projection', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('DELETE FROM "TrainingMoment";');
        expect(sql).toContain('DELETE FROM "CreditLedgerEntry";');
        expect(sql).toContain('DELETE FROM "AnalysisJob";');
        expect(sql).toContain('DELETE FROM "AnalysisRun";');
        expect(sql).toContain('"analyzedAt" = NULL');
        expect(sql).toContain('"currentAnalysisRunId" = NULL');
        expect(sql).toContain('"currentAnalysisValid" = false');
    });

    it('enforces the clean quality and price contract', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'CREATE TYPE "AnalysisQuality" AS ENUM (\'STANDARD\', \'THOROUGH\')'
        );
        expect(sql).toContain('"analysisQuality" "AnalysisQuality"');
        expect(sql).toContain('"creditCost" INTEGER');
        expect(sql).toContain('"analysisQuality" = \'STANDARD\'');
        expect(sql).toContain('"creditCost" = 7');
        expect(sql).toContain('"analysisQuality" = \'THOROUGH\'');
        expect(sql).toContain('"creditCost" = 10');
        expect(sql).toContain(
            'ALTER TABLE "AnalysisJob" DROP COLUMN "estimatedCredits"'
        );
    });

    it('replaces credit-like automation caps with plan-aware game limits', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('DROP COLUMN "autoAnalysisMonthlyCap"');
        expect(sql).toContain('DROP COLUMN "autoAnalysisDailyCap"');
        expect(sql).toContain('"autoAnalysisMonthlyGameLimit"');
        expect(sql).toContain('"autoAnalysisDailyGameLimit"');
        expect(sql).toContain('"serverCreditsPeriodStart"');
        expect(sql).toContain(
            '"serverCreditsRenewAt" = CURRENT_TIMESTAMP + INTERVAL \'1 month\''
        );
        expect(sql).toMatch(
            /WHEN 'PRO' THEN 5000\s+WHEN 'PLUS' THEN 500\s+ELSE 50/
        );
        expect(sql).toMatch(
            /WHEN 'PRO' THEN 250\s+WHEN 'PLUS' THEN 50\s+ELSE 10/
        );
    });
});
