import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';

function sqlText(query: Prisma.Sql): string {
    return query.strings.join('?');
}

describe('bounded practice feed queries', () => {
    it('selects only current verified due semantics and returns a keyset key', async () => {
        const queryRaw = vi.fn(async (query: Prisma.Sql) => {
            const text = sqlText(query);
            expect(text).toContain(
                `solution."id" = moment."currentSolutionRevisionId"`
            );
            expect(text).toContain(
                `solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"`
            );
            expect(text).not.toContain('AMBIGUOUS');
            expect(text).toContain(
                `state."solutionHash" = solution."solutionHash"`
            );
            expect(text).toContain(
                `state."configHash" = solution."configHash"`
            );
            expect(text).toContain('ORDER BY');
            expect(text).toContain('LIMIT ?');
            expect(query.values.at(-1)).toBe(13);
            return [
                {
                    id: '10000000-0000-4000-8000-000000000001',
                    currentSolutionRevisionId:
                        '20000000-0000-4000-8000-000000000001',
                    lapseBucket: 1,
                    lapses: 3,
                    nextDueAt: new Date('2026-01-01T00:00:00.000Z'),
                    lastReviewedAt: new Date(
                        '2025-12-01T00:00:00.000Z'
                    ),
                    createdAt: new Date('2025-01-01T00:00:00.000Z'),
                },
            ];
        });

        const rows = await queryDuePracticeStream({
            db: { $queryRaw: queryRaw } as never,
            userId: '30000000-0000-4000-8000-000000000001',
            feedStartedAt: new Date('2026-02-01T00:00:00.000Z'),
            filters: {
                focus: 'MAJOR',
                themes: ['quiet-move'],
            },
            take: 13,
        });

        expect(rows[0]?.key).toEqual({
            lapseBucket: 1,
            lapses: 3,
            nextDueAt: '2026-01-01T00:00:00.000Z',
            lastReviewedAt: '2025-12-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            id: '10000000-0000-4000-8000-000000000001',
        });
    });

    it('defines new positions as having no state for current solution semantics', async () => {
        const queryRaw = vi.fn(async (query: Prisma.Sql) => {
            const text = sqlText(query);
            expect(text).toContain('NOT EXISTS');
            expect(text).toContain(
                `state."solutionHash" = solution."solutionHash"`
            );
            expect(text).not.toContain(
                `state."lastReviewedAt" <=`
            );
            expect(text).toContain(
                `moment."createdAt" <= ?`
            );
            expect(query.values.at(-1)).toBe(5);
            return [];
        });

        await expect(
            queryNewPracticeStream({
                db: { $queryRaw: queryRaw } as never,
                userId:
                    '30000000-0000-4000-8000-000000000001',
                feedStartedAt: new Date(
                    '2026-02-01T00:00:00.000Z'
                ),
                filters: {},
                take: 5,
            })
        ).resolves.toEqual([]);
    });
});
