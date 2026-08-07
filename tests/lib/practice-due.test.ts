import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';
import {
    getPracticeDueSummary,
    getPracticeInventorySummary,
} from '@/lib/training/practiceDue';
import {
    initialDueScheduleCursor,
    initialNewScheduleCursor,
} from '@/lib/training/practiceScheduler';

vi.mock('@/lib/training/practiceFeedQueries', () => ({
    queryDuePracticeStream: vi.fn(),
    queryNewPracticeStream: vi.fn(),
}));

const queryDueMock = vi.mocked(queryDuePracticeStream);
const queryNewMock = vi.mocked(queryNewPracticeStream);

function dueCandidate(index: number) {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
        id,
        currentSolutionRevisionId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        key: {
            bucket: 'LAPSED' as const,
            nextDueAt: `2026-08-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        },
    };
}

function newCandidate(index: number) {
    const id = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
        id,
        currentSolutionRevisionId: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        key: { createdAt: '2026-08-01T00:00:00.000Z', id },
    };
}

describe('bounded practice availability signal', () => {
    beforeEach(() => {
        queryDueMock.mockReset().mockResolvedValue({
            candidates: [],
            startedAt: initialDueScheduleCursor(),
            scannedThrough: { bucket: 'DONE', after: null },
        });
        queryNewMock.mockReset().mockResolvedValue({
            candidates: [],
            startedAt: initialNewScheduleCursor(),
            scannedThrough: { after: null, exhausted: true },
        });
    });

    it('counts only due and new candidates and excludes future-reviewed inventory', async () => {
        queryDueMock.mockResolvedValue({
            candidates: [dueCandidate(1), dueCandidate(2)],
            startedAt: initialDueScheduleCursor(),
            scannedThrough: { bucket: 'DONE', after: null },
        });
        queryNewMock.mockResolvedValue({
            candidates: [newCandidate(1)],
            startedAt: initialNewScheduleCursor(),
            scannedThrough: {
                after: newCandidate(1).key,
                exhausted: true,
            },
        });

        await expect(
            getPracticeInventorySummary('user-1', new Date(), {} as never)
        ).resolves.toMatchObject({
            dueCount: 2,
            dueCountIsExact: true,
            newCount: 1,
            availableCount: 3,
            availableCountIsExact: true,
        });
    });

    it('reports an explicit lower bound when stale raw rows exhaust the slice budget', async () => {
        queryDueMock.mockResolvedValue({
            candidates: [],
            startedAt: initialDueScheduleCursor(),
            scannedThrough: {
                bucket: 'LAPSED',
                after: dueCandidate(99).key,
            },
        });

        const summary = await getPracticeInventorySummary(
            'user-1',
            new Date(),
            {} as never
        );

        expect(summary.dueCount).toBe(0);
        expect(summary.dueCountIsExact).toBe(false);
        expect(summary.availableCountIsExact).toBe(false);
        await expect(
            getPracticeDueSummary('user-1', new Date(), {} as never)
        ).resolves.toEqual({ state: 'UNKNOWN' });
    });

    it('caps counts at 100 and carries exactness into provider rechecks', async () => {
        queryDueMock.mockResolvedValue({
            candidates: Array.from({ length: 101 }, (_, index) =>
                dueCandidate(index + 1)
            ),
            startedAt: initialDueScheduleCursor(),
            scannedThrough: { bucket: 'DONE', after: null },
        });

        await expect(
            getPracticeDueSummary('user-1', new Date(), {} as never)
        ).resolves.toMatchObject({
            state: 'DUE',
            summary: {
                dueCount: 100,
                dueCountIsExact: false,
            },
        });
    });

    it('distinguishes an exact empty queue from an unknown bounded scan', async () => {
        await expect(
            getPracticeDueSummary('user-1', new Date(), {} as never)
        ).resolves.toEqual({ state: 'EMPTY' });
    });
});
