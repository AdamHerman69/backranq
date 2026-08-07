import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
    PracticeFeedRequest,
    PracticeFeedResponse,
    PracticeFilters,
    TrainingMomentResponse,
} from '@/lib/training/api';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';
import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';
import {
    interleavePracticeStreams,
    type DueScheduleKey,
    type NewScheduleKey,
    type PracticeScheduleCursor,
} from '@/lib/training/practiceScheduler';

type TrainingReadClient = Pick<
    Prisma.TransactionClient,
    'trainingMoment' | '$queryRaw'
>;

type PracticeFeedCursor = {
    version: 1;
    feedStartedAt: string;
    filterHash: string;
    schedule: PracticeScheduleCursor;
};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(cursor: PracticeFeedCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): {
    feedStartedAt: Date;
    filterHash: string;
    schedule: PracticeScheduleCursor;
} | null {
    try {
        const decoded = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8')
        ) as Partial<PracticeFeedCursor>;
        if (
            decoded.version !== 1 ||
            typeof decoded.feedStartedAt !== 'string' ||
            typeof decoded.filterHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(decoded.filterHash) ||
            !isPracticeScheduleCursor(decoded.schedule)
        ) {
            return null;
        }
        const feedStartedAt = new Date(decoded.feedStartedAt);
        if (!Number.isFinite(feedStartedAt.getTime())) {
            return null;
        }
        return {
            feedStartedAt,
            filterHash: decoded.filterHash,
            schedule: decoded.schedule,
        };
    } catch {
        return null;
    }
}

function isIsoDate(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNewScheduleKey(value: unknown): value is NewScheduleKey {
    if (!value || typeof value !== 'object') return false;
    const key = value as Partial<NewScheduleKey>;
    return (
        isIsoDate(key.createdAt) &&
        typeof key.id === 'string' &&
        UUID_RE.test(key.id)
    );
}

function isDueScheduleKey(value: unknown): value is DueScheduleKey {
    if (!isNewScheduleKey(value)) return false;
    const key = value as Partial<DueScheduleKey>;
    return (
        (key.lapseBucket === 0 || key.lapseBucket === 1) &&
        Number.isSafeInteger(key.lapses) &&
        (key.lapses ?? -1) >= 0 &&
        isIsoDate(key.nextDueAt) &&
        isIsoDate(key.lastReviewedAt)
    );
}

function isPracticeScheduleCursor(
    value: unknown
): value is PracticeScheduleCursor {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Partial<PracticeScheduleCursor>;
    return (
        Number.isSafeInteger(cursor.patternIndex) &&
        (cursor.patternIndex ?? -1) >= 0 &&
        (cursor.patternIndex ?? 3) < 3 &&
        (cursor.due === null || isDueScheduleKey(cursor.due)) &&
        (cursor.fresh === null || isNewScheduleKey(cursor.fresh))
    );
}

function sorted(values: readonly string[] | undefined): string[] {
    return Array.from(new Set(values ?? [])).sort();
}

function practiceFilterHash(filters: PracticeFilters): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                focus: filters.focus ?? 'ALL',
                phases: sorted(filters.phases),
                sourceKinds: sorted(filters.sourceKinds),
                lessonKinds: sorted(filters.lessonKinds),
                themes: sorted(filters.themes),
                minConfidence:
                    filters.minConfidence ?? null,
                mode: filters.mode ?? 'RECOMMENDED',
            })
        )
        .digest('hex');
}

const promptSelect = {
    id: true,
    currentSolutionRevisionId: true,
    fen: true,
    sideToMove: true,
    positionHistory: true,
    gameId: true,
    decisionPly: true,
    originalMoveUci: true,
    scoreBefore: true,
    scoreAfter: true,
    cpLoss: true,
    winChanceLoss: true,
    sourceKinds: true,
    lessonKinds: true,
    themes: true,
    game: {
        select: {
            provider: true,
            playedAt: true,
        },
    },
    currentSolutionRevision: {
        select: {
            bestMoveUci: true,
            acceptedMovesUci: true,
            acceptanceFrontier: true,
            solutionShape: true,
            bestLine: true,
            scoreAtStart: true,
            gradingPolicy: true,
            solutionTree: true,
            moveAssessments: {
                where: { status: 'VERIFIED' },
                orderBy: [
                    { decisionIndex: 'asc' as const },
                    { moveUci: 'asc' as const },
                ],
                select: {
                    decisionIndex: true,
                    fen: true,
                    moveUci: true,
                    source: true,
                    status: true,
                    grade: true,
                    scoreAfter: true,
                    evidence: true,
                },
            },
        },
    },
    createdAt: true,
    lastTrainedAt: true,
} satisfies Prisma.TrainingMomentSelect;

export class InvalidPracticeFeedCursorError extends Error {
    constructor() {
        super('Invalid practice feed cursor');
        this.name = 'InvalidPracticeFeedCursorError';
    }
}

export async function listPracticeFeed(args: {
    db: TrainingReadClient;
    userId: string;
    request: PracticeFeedRequest;
    now?: () => Date;
}): Promise<PracticeFeedResponse> {
    const limit = args.request.limit ?? 10;
    const filters = args.request.filters ?? {};
    const mode = filters.mode ?? 'RECOMMENDED';
    const filterHash = practiceFilterHash(filters);
    const cursor = args.request.cursor
        ? decodeCursor(args.request.cursor)
        : null;
    if (args.request.cursor && !cursor) {
        throw new InvalidPracticeFeedCursorError();
    }
    if (cursor && cursor.filterHash !== filterHash) {
        throw new InvalidPracticeFeedCursorError();
    }
    const requestTime = (args.now ?? (() => new Date()))();
    const feedStartedAt = cursor?.feedStartedAt ?? requestTime;
    if (feedStartedAt.getTime() > requestTime.getTime()) {
        throw new InvalidPracticeFeedCursorError();
    }

    const streamTake = limit + 1;
    const [due, fresh] = await Promise.all([
        mode === 'NEW'
            ? Promise.resolve([])
            : queryDuePracticeStream({
                  db: args.db,
                  userId: args.userId,
                  feedStartedAt,
                  filters,
                  cursor: cursor?.schedule.due,
                  take: streamTake,
              }),
        mode === 'REVIEW'
            ? Promise.resolve([])
            : queryNewPracticeStream({
                  db: args.db,
                  userId: args.userId,
                  feedStartedAt,
                  filters,
                  cursor: cursor?.schedule.fresh,
                  take: streamTake,
              }),
    ]);
    const scheduled = interleavePracticeStreams({
        due,
        fresh,
        mode,
        limit,
        ...(cursor ? { cursor: cursor.schedule } : {}),
    });
    if (scheduled.selected.length === 0) {
        return {
            items: [],
            appliedFilters: filters,
            nextCursor: null,
        };
    }

    const rows = await args.db.trainingMoment.findMany({
        where: {
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
            OR: scheduled.selected.map((candidate) => ({
                id: candidate.id,
                currentSolutionRevisionId:
                    candidate.currentSolutionRevisionId,
            })),
            currentSolutionRevision: {
                is: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
                },
            },
        },
        select: promptSelect,
    });
    const byCandidate = new Map(
        rows.map((row) => [
            `${row.id}:${row.currentSolutionRevisionId ?? ''}`,
            row,
        ])
    );
    const visible = scheduled.selected.flatMap((candidate) => {
        const row = byCandidate.get(
            `${candidate.id}:${candidate.currentSolutionRevisionId}`
        );
        return row ? [row] : [];
    });
    return {
        items: visible.map(toTrainingPromptDto),
        appliedFilters: filters,
        nextCursor:
            scheduled.hasMore
                ? encodeCursor({
                      version: 1,
                      feedStartedAt: feedStartedAt.toISOString(),
                      filterHash,
                      schedule: scheduled.cursor,
                  })
                : null,
    };
}

export async function getTrainingMomentPrompt(args: {
    db: TrainingReadClient;
    userId: string;
    momentId: string;
}): Promise<TrainingMomentResponse | null> {
    const row = await args.db.trainingMoment.findFirst({
        where: {
            id: args.momentId,
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
            currentSolutionRevisionId: { not: null },
            currentSolutionRevision: {
                is: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
                },
            },
        },
        select: promptSelect,
    });
    return row ? { moment: toTrainingPromptDto(row) } : null;
}
