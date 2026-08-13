import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import {
    PRACTICE_MAX_SCAN_SLICES,
    PRACTICE_SCAN_SLICE_SIZE,
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';

function sqlText(query: Prisma.Sql): string {
    return query.strings.join('?');
}

function uuid(index: number) {
    return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

describe('bounded practice feed queries', () => {
    it('materializes a lapsed raw slice before current verified joins', async () => {
        const queryRaw = vi.fn(async (query: Prisma.Sql) => {
            const text = sqlText(query);
            expect(text).toContain('WITH "rawDue" AS MATERIALIZED');
            expect(text.indexOf('LIMIT ?')).toBeLessThan(
                text.indexOf('LEFT JOIN LATERAL')
            );
            expect(text).toContain(
                `solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"`
            );
            expect(text).toContain(
                `solution."acceptanceFrontier"->>'status' = 'STABLE'`
            );
            expect(text).toContain(
                `raw."solutionHash" = solution."solutionHash"`
            );
            expect(text).toContain('moment."gameId" = ?::uuid');
            expect(text).toContain('scoped_moment."gameId" = ?::uuid');
            expect(query.values).toContain(uuid(4));
            if (text.includes('state."lapses" = 0')) return [];
            expect(text).toContain('state."lapses" > 0');
            return [
                {
                    stateId: uuid(9),
                    nextDueAt: new Date('2026-01-01T00:00:00.000Z'),
                    id: uuid(1),
                    currentSolutionRevisionId: uuid(2),
                },
            ];
        });

        const scan = await queryDuePracticeStream({
            db: { $queryRaw: queryRaw } as never,
            userId: uuid(3),
            feedStartedAt: new Date('2026-02-01T00:00:00.000Z'),
            filters: {
                focus: 'MAJOR',
                themes: ['quiet-move'],
                gameId: uuid(4),
            },
            take: 13,
        });

        expect(scan.candidates[0]?.key).toEqual({
            bucket: 'LAPSED',
            nextDueAt: '2026-01-01T00:00:00.000Z',
            id: uuid(9),
        });
        expect(scan.scannedThrough).toEqual({ bucket: 'DONE', after: null });
    });

    it('bounds stale due semantics to a fixed number of raw slices', async () => {
        let offset = 0;
        const queryRaw = vi.fn(async () => {
            const rows = Array.from(
                { length: PRACTICE_SCAN_SLICE_SIZE },
                (_, index) => ({
                    stateId: uuid(offset + index + 1),
                    nextDueAt: new Date('2026-01-01T00:00:00.000Z'),
                    id: null,
                    currentSolutionRevisionId: null,
                })
            );
            offset += rows.length;
            return rows;
        });

        const scan = await queryDuePracticeStream({
            db: { $queryRaw: queryRaw } as never,
            userId: uuid(3),
            feedStartedAt: new Date('2026-02-01T00:00:00.000Z'),
            filters: {},
            take: 5,
        });

        expect(scan.candidates).toEqual([]);
        expect(queryRaw).toHaveBeenCalledTimes(PRACTICE_MAX_SCAN_SLICES);
        expect(scan.scannedThrough).toEqual({
            bucket: 'LAPSED',
            after: {
                bucket: 'LAPSED',
                nextDueAt: '2026-01-01T00:00:00.000Z',
                id: uuid(PRACTICE_SCAN_SLICE_SIZE * PRACTICE_MAX_SCAN_SLICES),
            },
        });
    });

    it('materializes a bounded new-position scan before semantic filters', async () => {
        const queryRaw = vi.fn(async (query: Prisma.Sql) => {
            const text = sqlText(query);
            expect(text).toContain('WITH "rawNew" AS MATERIALIZED');
            expect(text.indexOf('LIMIT ?')).toBeLessThan(
                text.indexOf('LEFT JOIN LATERAL')
            );
            expect(text).toContain('NOT EXISTS');
            expect(text).toContain(
                `solution."acceptanceFrontier"->>'status' = 'STABLE'`
            );
            expect(text).toContain(
                `state."solutionHash" = solution."solutionHash"`
            );
            return [
                {
                    rawId: uuid(1),
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    id: uuid(1),
                    currentSolutionRevisionId: uuid(2),
                },
            ];
        });

        const scan = await queryNewPracticeStream({
            db: { $queryRaw: queryRaw } as never,
            userId: uuid(3),
            feedStartedAt: new Date('2026-02-01T00:00:00.000Z'),
            filters: {},
            take: 5,
        });

        expect(scan.candidates).toHaveLength(1);
        expect(scan.scannedThrough.exhausted).toBe(true);
    });
});
