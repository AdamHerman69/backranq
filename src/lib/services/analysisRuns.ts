import { createHash } from 'node:crypto';
import type {
    AnalysisExecutionMode,
    AnalysisRun,
    AnalysisRunStatus,
    Prisma,
} from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { Puzzle as UiPuzzle } from '@/lib/analysis/puzzles';
import { gameAnalysisToJson } from '@/lib/api/games';
import {
    replaceGamePuzzlesInTransaction,
    type ReplaceGamePuzzlesResult,
} from '@/lib/api/puzzlePersistence';
import { prisma } from '@/lib/prisma';

type AnalysisRunTransactionClient = Pick<
    Prisma.TransactionClient,
    'analysisRun' | 'analysisJob' | 'analyzedGame' | 'puzzle'
>;

type AnalysisRunEngineInput = {
    name?: string | null;
    version?: string | null;
    source?: string | null;
};

export type CreateAnalysisRunArgs = {
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
};

export type CompleteAnalysisRunArgs = {
    runId: string;
    analysis: GameAnalysis;
    puzzles: UiPuzzle[];
    userId?: string;
    gameId?: string;
    completedAt?: Date;
    consumedCredits?: number | null;
};

export type CompleteAnalysisRunResult = {
    run: AnalysisRun;
    game: {
        id: string;
        analyzedAt: Date | null;
        currentAnalysisRunId: string | null;
    };
    puzzles: ReplaceGamePuzzlesResult;
};

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
    const run = await args.tx.analysisRun.create({
        data: {
            userId: args.userId,
            gameId: args.gameId,
            executionMode: args.executionMode,
            status: args.status ?? 'QUEUED',
            queuedReason: args.queuedReason ?? null,
            engineName: args.engine?.name ?? null,
            engineVersion: args.engine?.version ?? null,
            engineSource: args.engine?.source ?? null,
            appVersion: args.appVersion ?? defaultAppVersion(),
            configSnapshot,
            configHash: args.configHash ?? hashAnalysisConfig(configSnapshot),
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
    return prisma.$transaction((tx) =>
        completeAnalysisRunWithGameAnalysisInTransaction({ tx, ...args })
    );
}

export async function completeAnalysisRunWithGameAnalysisInTransaction(
    args: CompleteAnalysisRunArgs & { tx: AnalysisRunTransactionClient }
): Promise<CompleteAnalysisRunResult> {
    const run = await args.tx.analysisRun.findFirst({
        where: {
            id: args.runId,
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        select: {
            id: true,
            userId: true,
            gameId: true,
            configHash: true,
            startedAt: true,
        },
    });
    if (!run) throw new Error('Analysis run not found');

    const completedAt = args.completedAt ?? new Date();
    const game = await args.tx.analyzedGame.update({
        where: { id: run.gameId },
        data: {
            analysis: gameAnalysisToJson(args.analysis) as Prisma.InputJsonValue,
            analyzedAt: completedAt,
            currentAnalysisRunId: run.id,
        },
        select: {
            id: true,
            analyzedAt: true,
            currentAnalysisRunId: true,
        },
    });

    const puzzles = await replaceGamePuzzlesInTransaction({
        tx: args.tx,
        userId: run.userId,
        gameId: run.gameId,
        puzzles: args.puzzles,
        analysisRunId: run.id,
        analysisConfigHash: run.configHash,
    });

    const updatedRun = await args.tx.analysisRun.update({
        where: { id: run.id },
        data: {
            status: 'SUCCEEDED',
            completedAt,
            durationMs: durationMs(run.startedAt, completedAt),
            consumedCredits: args.consumedCredits ?? undefined,
            lastError: null,
        },
    });

    return { run: updatedRun, game, puzzles };
}

export async function markAnalysisRunRunning(args: MarkAnalysisRunRunningArgs) {
    const run = await prisma.analysisRun.findFirst({
        where: {
            id: args.runId,
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        select: { id: true },
    });
    if (!run) throw new Error('Analysis run not found');

    return prisma.analysisRun.update({
        where: { id: run.id },
        data: {
            status: 'RUNNING',
            startedAt: args.startedAt ?? new Date(),
            completedAt: null,
            durationMs: null,
            lastError: null,
        },
    });
}

export async function markAnalysisRunFailed(args: FailAnalysisRunArgs) {
    const completedAt = args.completedAt ?? new Date();
    const run = await prisma.analysisRun.findFirst({
        where: {
            id: args.runId,
            ...(args.userId ? { userId: args.userId } : {}),
            ...(args.gameId ? { gameId: args.gameId } : {}),
        },
        select: { id: true, startedAt: true },
    });
    if (!run) throw new Error('Analysis run not found');

    return prisma.analysisRun.update({
        where: { id: run.id },
        data: {
            status: 'FAILED',
            completedAt,
            durationMs: durationMs(run.startedAt, completedAt),
            consumedCredits: args.consumedCredits ?? undefined,
            lastError: truncateError(args.error),
        },
    });
}
