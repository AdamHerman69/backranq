import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type {
    TrainingMomentResponse,
    TrainingSessionFilters,
    TrainingSessionFocus,
    TrainingSessionRequest,
    TrainingSessionResponse,
} from '@/lib/training/api';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';

type TrainingReadClient = Pick<Prisma.TransactionClient, 'trainingMoment'>;

type SessionCursor = {
    sessionStartedAt: string;
    filterHash: string;
    lastTrainedAt: string | null;
    createdAt: string;
    id: string;
};

function encodeCursor(cursor: SessionCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): {
    sessionStartedAt: Date;
    filterHash: string;
    lastTrainedAt: Date | null;
    createdAt: Date;
    id: string;
} | null {
    try {
        const decoded = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8')
        ) as Partial<SessionCursor>;
        if (
            typeof decoded.createdAt !== 'string' ||
            typeof decoded.sessionStartedAt !== 'string' ||
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
        const sessionStartedAt = new Date(decoded.sessionStartedAt);
        const lastTrainedAt =
            decoded.lastTrainedAt == null
                ? null
                : new Date(decoded.lastTrainedAt);
        if (
            !Number.isFinite(createdAt.getTime()) ||
            !Number.isFinite(sessionStartedAt.getTime()) ||
            (lastTrainedAt &&
                !Number.isFinite(lastTrainedAt.getTime()))
        ) {
            return null;
        }
        return {
            sessionStartedAt,
            filterHash: decoded.filterHash,
            lastTrainedAt,
            createdAt,
            id: decoded.id,
        };
    } catch {
        return null;
    }
}

const SESSION_FOCUS_THRESHOLDS: Record<
    Exclude<TrainingSessionFocus, 'ALL'>,
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

function sessionFilterHash(
    filters: TrainingSessionFilters
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
    focus: TrainingSessionFocus | undefined
): Prisma.TrainingMomentWhereInput | null {
    if (!focus || focus === 'ALL') return null;
    const threshold = SESSION_FOCUS_THRESHOLDS[focus];
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
    createdAt: true,
    lastTrainedAt: true,
} satisfies Prisma.TrainingMomentSelect;

function afterSessionCursor(
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

export class InvalidTrainingCursorError extends Error {
    constructor() {
        super('Invalid training session cursor');
        this.name = 'InvalidTrainingCursorError';
    }
}

export async function listTrainingSession(args: {
    db: TrainingReadClient;
    userId: string;
    request: TrainingSessionRequest;
}): Promise<TrainingSessionResponse> {
    const limit = args.request.limit ?? 10;
    const filters = args.request.filters ?? {};
    const filterHash = sessionFilterHash(filters);
    const cursor = args.request.cursor
        ? decodeCursor(args.request.cursor)
        : null;
    if (args.request.cursor && !cursor) {
        throw new InvalidTrainingCursorError();
    }
    if (cursor && cursor.filterHash !== filterHash) {
        throw new InvalidTrainingCursorError();
    }
    const requestTime = new Date();
    const sessionStartedAt =
        cursor?.sessionStartedAt ?? requestTime;
    if (sessionStartedAt.getTime() > requestTime.getTime()) {
        throw new InvalidTrainingCursorError();
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
                verificationStatus: {
                    in: ['VERIFIED', 'AMBIGUOUS'],
                },
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
            { createdAt: { lte: sessionStartedAt } },
            {
                OR: [
                    { lastTrainedAt: null },
                    {
                        lastTrainedAt: {
                            lt: sessionStartedAt,
                        },
                    },
                ],
            },
            ...(cursor ? [afterSessionCursor(cursor)] : []),
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
                      sessionStartedAt:
                          sessionStartedAt.toISOString(),
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
                    verificationStatus: {
                        in: ['VERIFIED', 'AMBIGUOUS'],
                    },
                },
            },
        },
        select: promptSelect,
    });
    return row ? { moment: toTrainingPromptDto(row) } : null;
}
