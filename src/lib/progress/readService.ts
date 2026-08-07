import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    aggregateProgressSnapshot,
    type ProgressAttemptRecord,
    type ProgressGameRecord,
    type ProgressPositionRecord,
    type ProgressUserRecord,
} from '@/lib/progress/aggregate';
import type {
    ProgressFilters,
    ProgressScope,
    ProgressSnapshot,
} from '@/lib/progress/contracts';
import { getEffectiveBillingAccount } from '@/lib/services/billingAccounts';

type ProgressReadClient = Pick<
    Prisma.TransactionClient,
    'user' | 'analyzedGame' | 'trainingMoment' | 'trainingAttempt'
>;

export type GetProgressSnapshotArgs = {
    userId: string;
    scope: ProgressScope;
    asOf: Date;
    filters: ProgressFilters;
};

export class ProgressUserNotFoundError extends Error {
    constructor() {
        super('Progress user not found');
        this.name = 'ProgressUserNotFoundError';
    }
}

export const PROGRESS_READ_LIMITS = {
    games: 25_000,
    positions: 25_000,
    attempts: 100_000,
    observationsPerPosition: 8,
} as const;

export class ProgressDatasetTooLargeError extends Error {
    constructor(readonly dataset: 'games' | 'positions' | 'attempts') {
        super(`Progress ${dataset} exceeded the safe read limit`);
        this.name = 'ProgressDatasetTooLargeError';
    }
}

const userSelect = {
    chessAccountConnections: { select: { provider: true } },
} satisfies Prisma.UserSelect;

const gameSelect = {
    id: true,
    provider: true,
    timeClass: true,
    sourcePgnHash: true,
    playedAt: true,
    analyzedAt: true,
    currentAnalysisRunId: true,
    currentAnalysisValid: true,
    currentAnalysisRun: {
        select: {
            id: true,
            status: true,
            inputPgnHash: true,
            configHash: true,
        },
    },
    analysisJobs: {
        select: {
            status: true,
            queuedReason: true,
        },
        take: 1,
    },
} satisfies Prisma.AnalyzedGameSelect;

const positionSelect = {
    id: true,
    gameId: true,
    sourcePgnHash: true,
    originalMoveUci: true,
    cpLoss: true,
    winChanceLoss: true,
    phase: true,
    status: true,
    sourceKinds: true,
    currentSolutionRevisionId: true,
    archivedAt: true,
    currentSolutionRevision: {
        select: {
            id: true,
            solutionHash: true,
            configHash: true,
            verificationStatus: true,
            trainable: true,
        },
    },
    observations: {
        orderBy: {
            createdAt: 'desc',
        },
        take: PROGRESS_READ_LIMITS.observationsPerPosition,
        select: {
            analysisRunId: true,
            solutionRevisionId: true,
            observedSolutionHash: true,
        },
    },
} satisfies Prisma.TrainingMomentSelect;

const attemptSelect = {
    id: true,
    trainingMomentId: true,
    solutionRevisionId: true,
    attemptedAt: true,
    completedAt: true,
    userMoveUci: true,
    status: true,
    grade: true,
    contextPhase: true,
    contextCpLoss: true,
    contextWinChanceLoss: true,
    contextSourceKinds: true,
    contextProvider: true,
    contextTimeClass: true,
    contextConfigHash: true,
    contextSolutionHash: true,
    steps: {
        where: {
            actor: 'USER',
        },
        orderBy: {
            stepIndex: 'asc',
        },
        take: 1,
        select: {
            stepIndex: true,
            actor: true,
            moveUci: true,
            grade: true,
        },
    },
} satisfies Prisma.TrainingAttemptSelect;

async function readProgressSnapshot(
    db: ProgressReadClient,
    args: GetProgressSnapshotArgs,
    serverCreditsBalance: number | null
): Promise<ProgressSnapshot> {
    if (
        !args.userId ||
        !Number.isFinite(args.asOf.getTime())
    ) {
        throw new TypeError('Invalid progress read arguments');
    }

    const [userRow, gameRows, positionRows, attemptRows] =
        await Promise.all([
            db.user.findUnique({
                where: { id: args.userId },
                select: userSelect,
            }),
            db.analyzedGame.findMany({
                where: {
                    userId: args.userId,
                    playedAt: { lte: args.asOf },
                },
                select: gameSelect,
                take: PROGRESS_READ_LIMITS.games + 1,
            }),
            db.trainingMoment.findMany({
                where: {
                    userId: args.userId,
                    status: 'ACTIVE',
                    archivedAt: null,
                    currentSolutionRevisionId: {
                        not: null,
                    },
                    currentSolutionRevision: {
                        is: {
                            trainable: true,
                            verificationStatus: {
                                in: ['VERIFIED', 'AMBIGUOUS'],
                            },
                        },
                    },
                    game: {
                        playedAt: { lte: args.asOf },
                    },
                },
                select: positionSelect,
                take: PROGRESS_READ_LIMITS.positions + 1,
            }),
            db.trainingAttempt.findMany({
                where: {
                    userId: args.userId,
                    completedAt: {
                        not: null,
                        lte: args.asOf,
                    },
                    status: {
                        in: [
                            'GRADED',
                            'REVEALED',
                            'UNRESOLVED',
                        ],
                    },
                },
                select: attemptSelect,
                take: PROGRESS_READ_LIMITS.attempts + 1,
            }),
        ]);

    if (!userRow) throw new ProgressUserNotFoundError();
    if (gameRows.length > PROGRESS_READ_LIMITS.games) {
        throw new ProgressDatasetTooLargeError('games');
    }
    if (positionRows.length > PROGRESS_READ_LIMITS.positions) {
        throw new ProgressDatasetTooLargeError('positions');
    }
    if (attemptRows.length > PROGRESS_READ_LIMITS.attempts) {
        throw new ProgressDatasetTooLargeError('attempts');
    }

    const user: ProgressUserRecord = {
        linkedAccounts: {
            lichess: userRow.chessAccountConnections.some(
                (connection) => connection.provider === 'LICHESS'
            ),
            chesscom: userRow.chessAccountConnections.some(
                (connection) => connection.provider === 'CHESSCOM'
            ),
        },
        serverCreditsBalance,
    };
    const games: ProgressGameRecord[] = gameRows.map(
        ({ analysisJobs, ...game }) => ({
            ...game,
            analysisJob: analysisJobs[0] ?? null,
        })
    );
    const positions: ProgressPositionRecord[] = positionRows;
    const attempts: ProgressAttemptRecord[] = attemptRows;

    return aggregateProgressSnapshot({
        request: {
            scope: args.scope,
            asOf: args.asOf,
            filters: args.filters,
        },
        user,
        games,
        positions,
        attempts,
    });
}

/**
 * Direct server/RSC entry point. The API route delegates to this same reader;
 * internal pages should call it directly rather than making an HTTP round trip.
 */
export async function getProgressSnapshot(
    args: GetProgressSnapshotArgs
): Promise<ProgressSnapshot> {
    const billingAccount = await getEffectiveBillingAccount(args.userId);
    return readProgressSnapshot(
        prisma,
        args,
        billingAccount.serverCreditsBalance
    );
}

export const progressReadTestUtils = {
    readProgressSnapshot,
};
