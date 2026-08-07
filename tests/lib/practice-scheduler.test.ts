import { describe, expect, it } from 'vitest';

import {
    initialDueScheduleCursor,
    initialNewScheduleCursor,
    interleavePracticeStreams,
    type DuePracticeScan,
    type DueScheduleCandidate,
    type NewPracticeScan,
    type NewScheduleCandidate,
} from '@/lib/training/practiceScheduler';

function due(index: number, bucket: 'LAPSED' | 'CLEAN' = 'LAPSED'):
    DueScheduleCandidate {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const stateId = `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
        id,
        currentSolutionRevisionId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        key: {
            bucket,
            nextDueAt: '2026-01-01T00:00:00.000Z',
            id: stateId,
        },
    };
}

function fresh(index: number): NewScheduleCandidate {
    const id = `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
        id,
        currentSolutionRevisionId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        key: {
            createdAt: '2026-01-01T00:00:00.000Z',
            id,
        },
    };
}

function dueScan(candidates: DueScheduleCandidate[]): DuePracticeScan {
    return {
        candidates,
        startedAt: initialDueScheduleCursor(),
        scannedThrough: { bucket: 'DONE', after: null },
    };
}

function newScan(candidates: NewScheduleCandidate[]): NewPracticeScan {
    return {
        candidates,
        startedAt: initialNewScheduleCursor(),
        scannedThrough: {
            after: candidates.at(-1)?.key ?? null,
            exhausted: true,
        },
    };
}

describe('practice stream scheduler', () => {
    it('uses a stable two-due-to-one-new recommendation pattern', () => {
        const result = interleavePracticeStreams({
            due: dueScan([due(1), due(2), due(3), due(4)]),
            fresh: newScan([fresh(1), fresh(2)]),
            mode: 'RECOMMENDED',
            limit: 6,
        });

        expect(result.selected.map((candidate) => candidate.id)).toEqual([
            due(1).id,
            due(2).id,
            fresh(1).id,
            due(3).id,
            due(4).id,
            fresh(2).id,
        ]);
        expect(result.cursor.patternIndex).toBe(0);
        expect(result.hasMore).toBe(false);
    });

    it('does not advance a raw watermark past an unconsumed candidate', () => {
        const candidates = [due(1), due(2), due(3)];
        const result = interleavePracticeStreams({
            due: {
                candidates,
                startedAt: initialDueScheduleCursor(),
                scannedThrough: {
                    bucket: 'CLEAN',
                    after: due(3, 'CLEAN').key,
                },
            },
            fresh: newScan([]),
            mode: 'REVIEW',
            limit: 1,
        });

        expect(result.cursor.due).toEqual({
            bucket: 'LAPSED',
            after: candidates[0]?.key,
        });
        expect(result.hasMore).toBe(true);
    });

    it('advances an empty stale-only slice and preserves continuation', () => {
        const scannedThrough = {
            bucket: 'LAPSED' as const,
            after: due(8).key,
        };
        const result = interleavePracticeStreams({
            due: {
                candidates: [],
                startedAt: initialDueScheduleCursor(),
                scannedThrough,
            },
            fresh: {
                candidates: [],
                startedAt: initialNewScheduleCursor(),
                scannedThrough: {
                    after: fresh(8).key,
                    exhausted: false,
                },
            },
            mode: 'RECOMMENDED',
            limit: 3,
        });

        expect(result.selected).toEqual([]);
        expect(result.cursor.due).toEqual(scannedThrough);
        expect(result.cursor.fresh.after).toEqual(fresh(8).key);
        expect(result.hasMore).toBe(true);
    });

    it('supports due-only and new-only exhausted queues', () => {
        expect(
            interleavePracticeStreams({
                due: dueScan([due(1), due(2)]),
                fresh: newScan([fresh(1)]),
                mode: 'REVIEW',
                limit: 1,
            }).selected.map((candidate) => candidate.id)
        ).toEqual([due(1).id]);
        expect(
            interleavePracticeStreams({
                due: dueScan([due(1)]),
                fresh: newScan([fresh(1), fresh(2)]),
                mode: 'NEW',
                limit: 1,
            }).selected.map((candidate) => candidate.id)
        ).toEqual([fresh(1).id]);
    });
});
