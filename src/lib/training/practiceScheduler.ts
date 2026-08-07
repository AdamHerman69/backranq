export type DuePracticeBucket = 'LAPSED' | 'CLEAN';

export type DueScheduleKey = {
    bucket: DuePracticeBucket;
    nextDueAt: string;
    id: string;
};

export type DueScheduleCursor =
    | {
          bucket: DuePracticeBucket;
          after: DueScheduleKey | null;
      }
    | {
          bucket: 'DONE';
          after: null;
      };

export type NewScheduleKey = {
    createdAt: string;
    id: string;
};

export type NewScheduleCursor = {
    after: NewScheduleKey | null;
    exhausted: boolean;
};

export type PracticeScheduleCursor = {
    due: DueScheduleCursor;
    fresh: NewScheduleCursor;
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

export type DuePracticeScan = {
    candidates: DueScheduleCandidate[];
    startedAt: DueScheduleCursor;
    scannedThrough: DueScheduleCursor;
};

export type NewPracticeScan = {
    candidates: NewScheduleCandidate[];
    startedAt: NewScheduleCursor;
    scannedThrough: NewScheduleCursor;
};

export const initialDueScheduleCursor = (): DueScheduleCursor => ({
    bucket: 'LAPSED',
    after: null,
});

export const initialNewScheduleCursor = (): NewScheduleCursor => ({
    after: null,
    exhausted: false,
});

export const initialPracticeScheduleCursor = (): PracticeScheduleCursor => ({
    due: initialDueScheduleCursor(),
    fresh: initialNewScheduleCursor(),
    patternIndex: 0,
});

const RECOMMENDED_PATTERN = ['DUE', 'DUE', 'NEW'] as const;

function dueCursorAfterConsumption(scan: DuePracticeScan, consumed: number) {
    if (consumed >= scan.candidates.length) return scan.scannedThrough;
    if (consumed === 0) return scan.startedAt;
    const key = scan.candidates[consumed - 1]?.key;
    return key
        ? ({ bucket: key.bucket, after: key } satisfies DueScheduleCursor)
        : scan.startedAt;
}

function newCursorAfterConsumption(scan: NewPracticeScan, consumed: number) {
    if (consumed >= scan.candidates.length) return scan.scannedThrough;
    if (consumed === 0) return scan.startedAt;
    const key = scan.candidates[consumed - 1]?.key;
    return key
        ? ({ after: key, exhausted: false } satisfies NewScheduleCursor)
        : scan.startedAt;
}

/**
 * Interleaves two bounded database scans. Scan watermarks advance past stale
 * rows only when doing so cannot skip an unconsumed visible candidate.
 */
export function interleavePracticeStreams(args: {
    due: DuePracticeScan;
    fresh: NewPracticeScan;
    mode: 'RECOMMENDED' | 'REVIEW' | 'NEW';
    limit: number;
    patternIndex?: number;
}) {
    let dueIndex = 0;
    let freshIndex = 0;
    let patternIndex = args.patternIndex ?? 0;
    const selected: Array<
        DueScheduleCandidate | NewScheduleCandidate
    > = [];

    const takeDue = () => {
        const candidate = args.due.candidates[dueIndex++];
        if (!candidate) return false;
        selected.push(candidate);
        return true;
    };
    const takeFresh = () => {
        const candidate = args.fresh.candidates[freshIndex++];
        if (!candidate) return false;
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
            dueIndex >= args.due.candidates.length &&
            freshIndex >= args.fresh.candidates.length
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

    const due = dueCursorAfterConsumption(args.due, dueIndex);
    const fresh = newCursorAfterConsumption(args.fresh, freshIndex);
    const hasMore =
        (args.mode !== 'NEW' && due.bucket !== 'DONE') ||
        (args.mode !== 'REVIEW' && !fresh.exhausted);

    return {
        selected,
        hasMore,
        cursor: {
            due,
            fresh,
            patternIndex,
        } satisfies PracticeScheduleCursor,
    };
}
