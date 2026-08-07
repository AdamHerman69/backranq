export type DueScheduleKey = {
    lapseBucket: 0 | 1;
    lapses: number;
    nextDueAt: string;
    lastReviewedAt: string;
    createdAt: string;
    id: string;
};

export type NewScheduleKey = {
    createdAt: string;
    id: string;
};

export type PracticeScheduleCursor = {
    due: DueScheduleKey | null;
    fresh: NewScheduleKey | null;
    patternIndex: number;
};

export type DueScheduleCandidate = {
    id: string;
    currentSolutionRevisionId: string;
    key: DueScheduleKey;
};

export type NewScheduleCandidate = {
    id: string;
    currentSolutionRevisionId: string;
    key: NewScheduleKey;
};

const RECOMMENDED_PATTERN = ['DUE', 'DUE', 'NEW'] as const;

/**
 * Interleaves two already ordered and bounded database streams. This function
 * never sorts or scans a user's inventory; SQL owns filtering and keyset order.
 */
export function interleavePracticeStreams(args: {
    due: readonly DueScheduleCandidate[];
    fresh: readonly NewScheduleCandidate[];
    mode: 'RECOMMENDED' | 'REVIEW' | 'NEW';
    limit: number;
    cursor?: PracticeScheduleCursor;
}) {
    let dueIndex = 0;
    let freshIndex = 0;
    let patternIndex = args.cursor?.patternIndex ?? 0;
    let dueCursor = args.cursor?.due ?? null;
    let freshCursor = args.cursor?.fresh ?? null;
    const selected: Array<{
        id: string;
        currentSolutionRevisionId: string;
    }> = [];

    const takeDue = () => {
        const candidate = args.due[dueIndex++];
        if (!candidate) return false;
        dueCursor = candidate.key;
        selected.push(candidate);
        return true;
    };
    const takeFresh = () => {
        const candidate = args.fresh[freshIndex++];
        if (!candidate) return false;
        freshCursor = candidate.key;
        selected.push(candidate);
        return true;
    };

    while (selected.length < args.limit) {
        if (args.mode === 'REVIEW') {
            if (!takeDue()) break;
            continue;
        }
        if (args.mode === 'NEW') {
            if (!takeFresh()) break;
            continue;
        }
        if (
            dueIndex >= args.due.length &&
            freshIndex >= args.fresh.length
        ) {
            break;
        }
        const preferred = RECOMMENDED_PATTERN[patternIndex];
        patternIndex = (patternIndex + 1) % RECOMMENDED_PATTERN.length;
        if (preferred === 'DUE') {
            if (!takeDue()) takeFresh();
        } else if (!takeFresh()) {
            takeDue();
        }
    }

    return {
        selected,
        hasMore:
            (args.mode !== 'NEW' && dueIndex < args.due.length) ||
            (args.mode !== 'REVIEW' && freshIndex < args.fresh.length),
        cursor: {
            due: dueCursor,
            fresh: freshCursor,
            patternIndex,
        } satisfies PracticeScheduleCursor,
    };
}
