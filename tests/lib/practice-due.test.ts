import { describe, expect, it, vi } from 'vitest';

import {
    getPracticeDueSummary,
    getPracticeInventorySummary,
    listPracticeDueSummaries,
} from '@/lib/training/practiceDue';

describe('practice due signal', () => {
    it('counts only due states matching the active verified current semantics', async () => {
        const due = {
            userId: '00000000-0000-4000-8000-000000000001',
            dueCount: 3,
            earliestDueAt: new Date('2026-08-01T09:00:00.000Z'),
        };
        const queryRaw = vi.fn().mockResolvedValue([due]);
        const now = new Date('2026-08-04T08:00:00.000Z');

        await expect(
            getPracticeDueSummary(due.userId, now, {
                $queryRaw: queryRaw,
            } as never)
        ).resolves.toEqual(due);

        const query = queryRaw.mock.calls[0]?.[0] as {
            strings: readonly string[];
            values: readonly unknown[];
        };
        const sql = query.strings.join(' ');
        expect(sql).toContain('WITH "dueUsers" AS');
        expect(sql).toContain('LIMIT');
        expect(sql).toMatch(
            /FROM "dueUsers" users\s+INNER JOIN "PracticeReviewState" state/
        );
        expect(sql).toContain('state."nextDueAt" <=');
        expect(sql).toContain('moment."status" = \'ACTIVE\'');
        expect(sql).toContain('solution."trainable" = true');
        expect(sql).toContain("'VERIFIED'::\"VerificationStatus\"");
        expect(sql).not.toContain('AMBIGUOUS');
        expect(sql).toContain(
            'state."solutionHash" = solution."solutionHash"'
        );
        expect(sql).toContain(
            'state."configHash" = solution."configHash"'
        );
        expect(query.values).toContain(now);
        expect(query.values).toContain(due.userId);
    });

    it('pages due users by stable user id for scheduler continuation', async () => {
        const queryRaw = vi.fn().mockResolvedValue([]);

        await listPracticeDueSummaries({
            now: new Date('2026-08-04T08:00:00.000Z'),
            afterUserId: '00000000-0000-4000-8000-000000000001',
            limit: 200,
            db: { $queryRaw: queryRaw } as never,
        });

        const query = queryRaw.mock.calls[0]?.[0] as {
            strings: readonly string[];
        };
        const sql = query.strings.join(' ');
        expect(sql).toContain('state."userId" >');
        expect(sql).toContain('ORDER BY state."userId" ASC');
    });

    it('counts all current eligible positions even when none are due yet', async () => {
        const inventory = {
            userId: '00000000-0000-4000-8000-000000000001',
            totalEligibleCount: 6,
            dueCount: 0,
            earliestDueAt: null,
        };
        const queryRaw = vi.fn().mockResolvedValue([inventory]);

        await expect(
            getPracticeInventorySummary(
                inventory.userId,
                new Date('2026-08-04T08:00:00.000Z'),
                { $queryRaw: queryRaw } as never
            )
        ).resolves.toEqual(inventory);

        const query = queryRaw.mock.calls[0]?.[0] as {
            strings: readonly string[];
        };
        const sql = query.strings.join(' ');
        expect(sql).toContain('COUNT(*)::int AS "totalEligibleCount"');
        expect(sql).toContain('LEFT JOIN "PracticeReviewState" state');
        expect(sql).toContain(
            'state."solutionHash" = solution."solutionHash"'
        );
        expect(sql).not.toContain('AMBIGUOUS');
    });
});
