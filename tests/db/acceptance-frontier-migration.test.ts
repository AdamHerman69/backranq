import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260806120000_add_authoritative_acceptance_frontier/migration.sql'
);

describe('authoritative acceptance frontier migration', () => {
    it('removes V2 playable content before making the V3 frontier required', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const trainingReset = sql.indexOf('DELETE FROM "TrainingMoment"');
        const publicationReset = sql.indexOf(
            'DELETE FROM "MasterPublication"'
        );
        const solutionColumn = sql.indexOf(
            'ALTER TABLE "SolutionRevision"'
        );
        const masterColumn = sql.indexOf(
            'ALTER TABLE "MasterCandidate"'
        );

        expect(trainingReset).toBeGreaterThan(-1);
        expect(publicationReset).toBeGreaterThan(-1);
        expect(trainingReset).toBeLessThan(solutionColumn);
        expect(publicationReset).toBeLessThan(masterColumn);
        expect(sql).toContain(
            'ADD COLUMN "acceptanceFrontier" JSONB NOT NULL;'
        );
        expect(sql).not.toMatch(
            /"acceptanceFrontier" JSONB NOT NULL DEFAULT/
        );
    });

    it('adds the STRONG attempt tier', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'ALTER TYPE "AttemptGrade" ADD VALUE \'STRONG\''
        );
    });
});
