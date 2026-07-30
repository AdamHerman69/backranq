import { createHash } from 'node:crypto';
import type {
    AnalysisExecutionMode,
    AnalysisRun,
    AnalysisRunStatus,
    Prisma,
} from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import { gameAnalysisToJson } from '@/lib/api/games';
import {
    replaceTrainingMomentsInTransaction,
    type ReplaceTrainingMomentsResult,
} from '@/lib/api/trainingMomentPersistence';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { prisma } from '@/lib/prisma';
import type { AnalysisDispatchFence } from '@/lib/services/analysisDispatchFence';
import type { TrainingMomentCandidate } from '@/lib/training/contracts';

type AnalysisRunTransactionClient = Pick<
    Prisma.TransactionClient,
    | 'analysisRun'
    | 'analysisJob'
    | 'analyzedGame'
    | 'trainingMoment'
    | 'solutionRevision'
    | 'solutionMoveAssessment'
    | 'trainingMomentObservation'
>;

type AnalysisRunEngineInput = {
    name?: string | null;
    version?: string | null;
    source?: string | null;
    flavor?: string | null;
    evalFile?: string | null;
    options?: unknown;
};

export type CreateAnalysisRunArgs = {
    id?: string;
    userId: string;
    gameId: string;
    executionMode: AnalysisExecutionMode;
    status?: AnalysisRunStatus;
    queuedReason?: string | null;
    engine?: AnalysisRunEngineInput;
    appVersion?: string | null;
    configSnapshot?: unknown;
    configHash?: string;
    startedAt?: Date | null;
    consumedCredits?: number | null;
    analysisJobId?: string | null;
    inputPgnHash?: string;
};

export type CompleteAnalysisRunArgs = {
    runId: string;
    analysis: GameAnalysis;
    trainingMoments: TrainingMomentCandidate[];
    extractionManifest: ExtractionCompletionManifest;
    userId?: string;
    gameId?: string;
    completedAt?: Date;
    consumedCredits?: number | null;
    analysisJob?: {
        id: string;
        fence: AnalysisDispatchFence;
    };
};

export type CompleteAnalysisRunResult = {
    run: AnalysisRun;
    game: {
        id: string;
        analyzedAt: Date | null;
        currentAnalysisRunId: string | null;
    };
    trainingMoments: ReplaceTrainingMomentsResult;
};

export type CreateAndCompleteLocalAnalysisRunArgs = {
    run: Omit<CreateAnalysisRunArgs, 'status' | 'analysisJobId'>;
    completion: Omit<
        CompleteAnalysisRunArgs,
        'runId' | 'analysisJob'
    >;
};

export const ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS = {
    maxWait: 5_000,
    timeout: 30_000,
} as const;

export class SourcePgnChangedError extends Error {
    constructor(message = 'Source PGN changed during analysis') {
        super(message);
        this.name = 'SourcePgnChangedError';
    }
}

export class AnalysisConfigHashMismatchError extends Error {
    constructor(message = 'configHash does not match configSnapshot') {
        super(message);
        this.name = 'AnalysisConfigHashMismatchError';
    }
}

export async function completeAnalysisRunWithoutGameWrite(args: {
    runId: string;
    analysisJobId: string;
    fence: AnalysisDispatchFence;
    completedAt?: Date;
    consumedCredits?: number;
}) {
    const completedAt = args.completedAt ?? new Date();
    return prisma.$transaction(async (tx) => {
        const job = await tx.analysisJob.updateMany({
            where: {
                id: args.analysisJobId,
                analysisRunId: args.runId,
                status: 'RUNNING',
                lockedAt: args.fence.lockedAt,
                dispatchedCount: args.fence.dispatchedCount,
            },
            data: {
                status: 'SUCCEEDED',
                lockedAt: null,
                lockedUntil: null,
                completedAt,
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:release:completion-committed',
            },
        });
        if (job.count !== 1) {
            throw new Error('Analysis completion rejected by stale-worker fence');
        }

        const currentRun = await tx.analysisRun.findFirst({
            where: {
                id: args.runId,
                status: 'RUNNING',
            },
            select: { id: true, startedAt: true },
        });
        if (!currentRun) {
            throw new Error('Analysis run is not current or running');
        }
        const run = await tx.analysisRun.updateMany({
            where: {
                id: currentRun.id,
                status: 'RUNNING',
            },
            data: {
                status: 'SUCCEEDED',
                completedAt,
                durationMs: durationMs(currentRun.startedAt, completedAt),
                consumedCredits: args.consumedCredits ?? 0,
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:release:completion-committed',
            },
        });
        if (run.count !== 1) {
            throw new Error('Analysis run is not current or running');
        }
        return { completedAt };
    });
}

type FailAnalysisRunArgs = {
    runId: string;
    error: unknown;
    userId?: string;
    gameId?: string;
    completedAt?: Date;
    consumedCredits?: number | null;
};

type MarkAnalysisRunRunningArgs = {
    runId: string;
    userId?: string;
    gameId?: string;
    startedAt?: Date;
};

function canonicalizeForHash(value: unknown): unknown {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalizeForHash);

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) out[key] = canonicalizeForHash(v);
    }
    return out;
}

export function stableAnalysisConfigString(configSnapshot: unknown): string {
    return JSON.stringify(canonicalizeForHash(configSnapshot ?? {}));
}

export function hashAnalysisConfig(configSnapshot: unknown): string {
    return createHash('sha256')
        .update(stableAnalysisConfigString(configSnapshot))
        .digest('hex');
}

function truncateError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2_000);
}

function durationMs(startedAt: Date | null, completedAt: Date): number | null {
    if (!startedAt) return null;
    return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function assertCompleteExtractionManifest(args: {
    manifest: ExtractionCompletionManifest;
    gameId: string;
    sourcePgnHash: string;
    analyzedPlies: number;
}) {
    const manifest = args.manifest;
    if (
        manifest.version !== 1 ||
        manifest.complete !== true ||
        manifest.sourceGameId !== args.gameId ||
        manifest.sourcePgnHash !== args.sourcePgnHash ||
        manifest.termination !== 'COMPLETED' ||
        !Number.isSafeInteger(manifest.scannedPlies) ||
        manifest.scannedPlies < 0 ||
        manifest.scannedPlies !== manifest.expectedPlies ||
        manifest.expectedPlies !== args.analyzedPlies ||
        manifest.errors.length !== 0
    ) {
        throw new Error(
            'Complete extraction manifest does not match the analysis run'
        );
    }
}

function defaultAppVersion() {
    return (
        process.env.NEXT_PUBLIC_APP_VERSION ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        null
    );
}

export async function createAnalysisRun(args: CreateAnalysisRunArgs) {
    return prisma.$transaction((tx) =>
        createAnalysisRunInTransaction({ tx, ...args })
    );
}

export async function createAnalysisRunInTransaction(
    args: CreateAnalysisRunArgs & { tx: AnalysisRunTransactionClient }
) {
    const configSnapshot = (args.configSnapshot ?? {}) as Prisma.InputJsonValue;
    const computedConfigHash = hashAnalysisConfig(configSnapshot);
    if (args.configHash && args.configHash !== computedConfigHash) {
        throw new AnalysisConfigHashMismatchError();
    }
    const sourceGame = await args.tx.analyzedGame.findFirst({
        where: { id: args.gameId, userId: args.userId },
        select: { pgn: true },
    });
    if (!sourceGame) throw new Error('Source game not found');
    const inputPgnHash = hashSourcePgn(sourceGame.pgn);
    if (args.inputPgnHash && args.inputPgnHash !== inputPgnHash) {
        throw new SourcePgnChangedError();
    }
    const run = await args.tx.analysisRun.create({
        data: {
            ...(args.id ? { id: args.id } : {}),
            userId: args.userId,
            gameId: args.gameId,
            executionMode: args.executionMode,
            status: args.status ?? 'QUEUED',
            queuedReason: args.queuedReason ?? null,
            engineName: args.engine?.name ?? null,
            engineVersion: args.engine?.version ?? null,
            engineSource: args.engine?.source ?? null,
            engineFlavor: args.engine?.flavor ?? null,
            engineEvalFile: args.engine?.evalFile ?? null,
            engineOptions: (args.engine?.options ??
                {}) as Prisma.InputJsonValue,
            appVersion: args.appVersion ?? defaultAppVersion(),
            inputPgnHash,
            configSnapshot,
            configHash: computedConfigHash,
            startedAt: args.startedAt ?? null,
            consumedCredits: args.consumedCredits ?? null,
        },
    });

    if (args.analysisJobId) {
        await args.tx.analysisJob.update({
            where: { id: args.analysisJobId },
            data: { analysisRunId: run.id },
        });
    }

    return run;
}

export async function completeAnalysisRunWithGameAnalysis(
    args: CompleteAnalysisRunArgs
): Promise<CompleteAnalysisRunResult> {
    return prisma.$transaction(
        (tx) =>
            completeAnalysisRunWithGameAnalysisInTransaction({
                tx,
                ...args,
            }),
        ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS
    );
}

/**
 * Persist a browser-produced analysis in one atomic boundary. If any game,
 * training-moment, or terminal run write fails, creation of the RUNNING run
 * rolls back with it, so a failed local upload cannot leave an active run
 * behind and block a clean retry.
 */
export async function createAndCompleteLocalAnalysisRun(
    args: CreateAndCompleteLocalAnalysisRunArgs
): Promise<CompleteAnalysisRunResult> {
    return prisma.$transaction(
        async (tx) => {
            const run = await createAnalysisRunInTransaction({
                tx,
                ...args.run,
                status: 'RUNNING',
            });
            return completeAnalysisRunWithGameAnalysisInTransaction({
                tx,
                ...args.completion,
                runId: run.id,
            });
        },
        ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS
    );
}

export async function completeAnalysisRunWithGameAnalysisInTransaction(
    args: CompleteAnalysisRunArgs & { tx: AnalysisRunTransactionClient }
): Promise<CompleteAnalysisRunResult> {
    const completedAt = args.completedAt ?? new Date();
    if (args.analysisJob) {
        const fencedJob = await args.tx.analysisJob.updateMany({
            where: {
                id: args.analysisJob.id,
                status: 'RUNNING',
                lockedAt: args.analysisJob.fence.lockedAt,
                dispatchedCount: args.analysisJob.fence.dispatchedCount,
                analysisRunId: args.runId,
            },
            data: {
                status: 'SUCCEEDED',
                lockedAt: null,
                lockedUntil: null,
                completedAt,
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:consume:completion-committed',
            },
        });
        if (fencedJob.count !== 1) {
            throw new Error('Analysis completion rejected by stale-worker fence');
        }
    }

    const run = await args.tx.analysisRun.findFirst({
        where: {
            id: args.runId,
            status: 'RUNNING',
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        select: {
            id: true,
            userId: true,
            gameId: true,
            configHash: true,
            inputPgnHash: true,
            startedAt: true,
        },
    });
    if (!run) throw new Error('Analysis run is not current or running');
    if (!run.inputPgnHash) {
        throw new SourcePgnChangedError('Analysis run has no source PGN hash');
    }

    const sourceGame = await args.tx.analyzedGame.findFirst({
        where: {
            id: run.gameId,
            ...(args.userId ? { userId: args.userId } : {}),
        },
        select: { id: true, pgn: true, provider: true, playedAt: true },
    });
    if (
        !sourceGame ||
        hashSourcePgn(sourceGame.pgn) !== run.inputPgnHash
    ) {
        throw new SourcePgnChangedError();
    }
    assertCompleteExtractionManifest({
        manifest: args.extractionManifest,
        gameId: run.gameId,
        sourcePgnHash: run.inputPgnHash,
        analyzedPlies: args.analysis.moves.length,
    });

    const gameWrite = await args.tx.analyzedGame.updateMany({
        where: {
            id: run.gameId,
            pgn: sourceGame.pgn,
        },
        data: {
            analysis: gameAnalysisToJson(args.analysis) as Prisma.InputJsonValue,
            analyzedAt: completedAt,
            currentAnalysisRunId: run.id,
        },
    });
    if (gameWrite.count !== 1) throw new SourcePgnChangedError();
    const game = await args.tx.analyzedGame.findUniqueOrThrow({
        where: { id: run.gameId },
        select: {
            id: true,
            analyzedAt: true,
            currentAnalysisRunId: true,
        },
    });

    const trainingMoments = await replaceTrainingMomentsInTransaction({
        tx: args.tx,
        userId: run.userId,
        gameId: run.gameId,
        sourceProvider:
            sourceGame.provider === 'LICHESS' ? 'lichess' : 'chesscom',
        sourcePlayedAt: sourceGame.playedAt,
        sourcePgnHash: run.inputPgnHash,
        moments: args.trainingMoments,
        analysisRunId: run.id,
        analysisConfigHash: run.configHash,
        extractionManifest: args.extractionManifest,
    });

    const runWrite = await args.tx.analysisRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
            status: 'SUCCEEDED',
            completedAt,
            durationMs: durationMs(run.startedAt, completedAt),
            consumedCredits: args.consumedCredits ?? undefined,
            lastError: args.analysisJob
                ? 'CREDIT_SETTLEMENT_PENDING:consume:completion-committed'
                : null,
        },
    });
    if (runWrite.count !== 1) {
        throw new Error('Analysis run is not current or running');
    }
    const updatedRun = await args.tx.analysisRun.findUniqueOrThrow({
        where: { id: run.id },
    });

    return { run: updatedRun, game, trainingMoments };
}

export async function markAnalysisRunRunning(args: MarkAnalysisRunRunningArgs) {
    const startedAt = args.startedAt ?? new Date();
    const run = await prisma.analysisRun.updateMany({
        where: {
            id: args.runId,
            status: 'QUEUED',
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        data: {
            status: 'RUNNING',
            startedAt,
            completedAt: null,
            durationMs: null,
            lastError: null,
        },
    });
    if (run.count !== 1) {
        throw new Error('Analysis run is not queued or current');
    }
    return prisma.analysisRun.findUniqueOrThrow({
        where: { id: args.runId },
    });
}

export async function markAnalysisRunFailed(args: FailAnalysisRunArgs) {
    const completedAt = args.completedAt ?? new Date();
    const run = await prisma.analysisRun.findFirst({
        where: {
            id: args.runId,
            status: { in: ['QUEUED', 'RUNNING'] },
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        select: { id: true, startedAt: true },
    });
    if (!run) throw new Error('Analysis run not found');

    const failed = await prisma.analysisRun.updateMany({
        where: {
            id: run.id,
            status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
            status: 'FAILED',
            completedAt,
            durationMs: durationMs(run.startedAt, completedAt),
            consumedCredits: args.consumedCredits ?? undefined,
            lastError: truncateError(args.error),
        },
    });
    if (failed.count !== 1) {
        throw new Error('Analysis run is already terminal');
    }
    return prisma.analysisRun.findUniqueOrThrow({
        where: { id: run.id },
    });
}
