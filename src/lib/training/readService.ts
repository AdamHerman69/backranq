import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
    PracticeFeedFocus,
    PracticeFeedRequest,
    PracticeFeedResponse,
    PracticeFilters,
    TrainingMomentResponse,
} from '@/lib/training/api';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';

type TrainingReadClient = Pick<Prisma.TransactionClient, 'trainingMoment'>;

type PracticeFeedCursor = {
    feedStartedAt: string;
    filterHash: string;
    lastTrainedAt: string | null;
    createdAt: string;
    id: string;
};

function encodeCursor(cursor: PracticeFeedCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): {
    feedStartedAt: Date;
    filterHash: string;
    lastTrainedAt: Date | null;
    createdAt: Date;
    id: string;
} | null {
    try {
        const decoded = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8')
        ) as Partial<PracticeFeedCursor>;
        if (
            typeof decoded.createdAt !== 'string' ||
            typeof decoded.feedStartedAt !== 'string' ||
            typeof decoded.filterHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(decoded.filterHash) ||
            (decoded.lastTrainedAt !== null &&
                typeof decoded.lastTrainedAt !== 'string') ||
            typeof decoded.id !== 'string' ||
            decoded.id.length > 128
        ) {
            return null;
        }
        const createdAt = new Date(decoded.createdAt);
        const feedStartedAt = new Date(decoded.feedStartedAt);
        const lastTrainedAt =
            decoded.lastTrainedAt == null
                ? null
                : new Date(decoded.lastTrainedAt);
        if (
            !Number.isFinite(createdAt.getTime()) ||
            !Number.isFinite(feedStartedAt.getTime()) ||
            (lastTrainedAt &&
                !Number.isFinite(lastTrainedAt.getTime()))
        ) {
            return null;
        }
        return {
            feedStartedAt,
            filterHash: decoded.filterHash,
            lastTrainedAt,
            createdAt,
            id: decoded.id,
        };
    } catch {
        return null;
    }
}

const PRACTICE_FOCUS_THRESHOLDS: Record<
    Exclude<PracticeFeedFocus, 'ALL'>,
    {
        minWinChanceLoss: number;
        fallbackMinCpLoss: number;
    }
> = {
    MEANINGFUL: {
        minWinChanceLoss: 0.08,
        fallbackMinCpLoss: 100,
    },
    MAJOR: {
        minWinChanceLoss: 0.12,
        fallbackMinCpLoss: 150,
    },
};

function sorted(values: readonly string[] | undefined): string[] {
    return Array.from(new Set(values ?? [])).sort();
}

function practiceFilterHash(
    filters: PracticeFilters
): string {
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
                includeAttempted:
                    filters.includeAttempted !== false,
            })
        )
        .digest('hex');
}

function severityWhere(
    focus: PracticeFeedFocus | undefined
): Prisma.TrainingMomentWhereInput | null {
    if (!focus || focus === 'ALL') return null;
    const threshold = PRACTICE_FOCUS_THRESHOLDS[focus];
    return {
        OR: [
            {
                winChanceLoss: {
                    gte: threshold.minWinChanceLoss,
                },
            },
            {
                winChanceLoss: null,
                cpLoss: {
                    gte: threshold.fallbackMinCpLoss,
                },
            },
        ],
    };
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

function afterPracticeFeedCursor(
    cursor: NonNullable<ReturnType<typeof decodeCursor>>
): Prisma.TrainingMomentWhereInput {
    if (cursor.lastTrainedAt === null) {
        return {
            OR: [
                {
                    lastTrainedAt: null,
                    createdAt: { gt: cursor.createdAt },
                },
                {
                    lastTrainedAt: null,
                    createdAt: cursor.createdAt,
                    id: { gt: cursor.id },
                },
                { lastTrainedAt: { not: null } },
            ],
        };
    }
    return {
        OR: [
            {
                lastTrainedAt: { gt: cursor.lastTrainedAt },
            },
            {
                lastTrainedAt: cursor.lastTrainedAt,
                createdAt: { gt: cursor.createdAt },
            },
            {
                lastTrainedAt: cursor.lastTrainedAt,
                createdAt: cursor.createdAt,
                id: { gt: cursor.id },
            },
        ],
    };
}

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
}): Promise<PracticeFeedResponse> {
    const limit = args.request.limit ?? 10;
    const filters = args.request.filters ?? {};
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
    const requestTime = new Date();
    const feedStartedAt =
        cursor?.feedStartedAt ?? requestTime;
    if (feedStartedAt.getTime() > requestTime.getTime()) {
        throw new InvalidPracticeFeedCursorError();
    }

    const severityFilter = severityWhere(filters.focus);
    const where: Prisma.TrainingMomentWhereInput = {
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
        ...(filters.phases?.length
            ? { phase: { in: filters.phases } }
            : {}),
        ...(filters.sourceKinds?.length
            ? { sourceKinds: { hasSome: filters.sourceKinds } }
            : {}),
        ...(filters.lessonKinds?.length
            ? { lessonKinds: { hasSome: filters.lessonKinds } }
            : {}),
        ...(filters.themes?.length
            ? { themes: { hasEvery: filters.themes } }
            : {}),
        ...(filters.minConfidence !== undefined
            ? { confidence: { gte: filters.minConfidence } }
            : {}),
        ...(filters.includeAttempted === false
            ? {
                  attempts: {
                      none: {
                          userId: args.userId,
                          status: { in: ['GRADED', 'REVEALED'] },
                      },
                  },
              }
            : {}),
        AND: [
            ...(severityFilter ? [severityFilter] : []),
            { createdAt: { lte: feedStartedAt } },
            {
                OR: [
                    { lastTrainedAt: null },
                    {
                        lastTrainedAt: {
                            lt: feedStartedAt,
                        },
                    },
                ],
            },
            ...(cursor ? [afterPracticeFeedCursor(cursor)] : []),
        ],
    };

    const rows = await args.db.trainingMoment.findMany({
        where,
        select: promptSelect,
        orderBy: [
            {
                lastTrainedAt: {
                    sort: 'asc',
                    nulls: 'first',
                },
            },
            { createdAt: 'asc' },
            { id: 'asc' },
        ],
        take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const last = visible.at(-1);
    return {
        items: visible.map(toTrainingPromptDto),
        appliedFilters: filters,
        nextCursor:
            hasMore && last
                ? encodeCursor({
                      createdAt: last.createdAt.toISOString(),
                      feedStartedAt:
                          feedStartedAt.toISOString(),
                      filterHash,
                      lastTrainedAt:
                          last.lastTrainedAt?.toISOString() ??
                          null,
                      id: last.id,
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
