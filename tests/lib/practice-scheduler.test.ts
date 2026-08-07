import { describe, expect, it } from 'vitest';

import {
    interleavePracticeStreams,
    type DueScheduleCandidate,
    type NewScheduleCandidate,
} from '@/lib/training/practiceScheduler';

function due(index: number): DueScheduleCandidate {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
        id,
        currentSolutionRevisionId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        key: {
            lapseBucket: index % 2 === 0 ? 1 : 0,
            lapses: index,
            nextDueAt: '2026-01-01T00:00:00.000Z',
            lastReviewedAt: '2025-12-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            id,
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

describe('practice stream scheduler', () => {
    it('uses a stable two-due-to-one-new recommendation pattern', () => {
        const result = interleavePracticeStreams({
            due: [due(1), due(2), due(3), due(4)],
            fresh: [fresh(1), fresh(2)],
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

    it('fills the page from the remaining stream without duplicates', () => {
        const result = interleavePracticeStreams({
            due: [],
            fresh: [fresh(1), fresh(2), fresh(3)],
            mode: 'RECOMMENDED',
            limit: 3,
        });

        expect(result.selected.map((candidate) => candidate.id)).toEqual([
            fresh(1).id,
            fresh(2).id,
            fresh(3).id,
        ]);
        expect(result.cursor.due).toBeNull();
        expect(result.cursor.fresh).toEqual(fresh(3).key);
    });

    it('resumes the recommendation pattern and independent stream keys', () => {
        const first = interleavePracticeStreams({
            due: [due(1), due(2)],
            fresh: [fresh(1), fresh(2)],
            mode: 'RECOMMENDED',
            limit: 1,
        });
        const second = interleavePracticeStreams({
            due: [due(2)],
            fresh: [fresh(1), fresh(2)],
            mode: 'RECOMMENDED',
            limit: 2,
            cursor: first.cursor,
        });

        expect(second.selected.map((candidate) => candidate.id)).toEqual([
            due(2).id,
            fresh(1).id,
        ]);
        expect(second.cursor.due).toEqual(due(2).key);
        expect(second.cursor.fresh).toEqual(fresh(1).key);
    });

    it('supports due-only and new-only queues', () => {
        expect(
            interleavePracticeStreams({
                due: [due(1), due(2)],
                fresh: [fresh(1)],
                mode: 'REVIEW',
                limit: 1,
            }).selected.map((candidate) => candidate.id)
        ).toEqual([due(1).id]);
        expect(
            interleavePracticeStreams({
                due: [due(1)],
                fresh: [fresh(1), fresh(2)],
                mode: 'NEW',
                limit: 1,
            }).selected.map((candidate) => candidate.id)
        ).toEqual([fresh(1).id]);
    });
});
