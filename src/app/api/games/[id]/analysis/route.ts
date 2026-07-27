import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type {
    GameAnalysis,
    MoveClassification,
} from '@/lib/analysis/classification';
import { providerToUi } from '@/lib/api/games';
import { validatePuzzleReplacementBody } from '../puzzles/validation';
import {
    completeAnalysisRunWithGameAnalysis,
    createAnalysisRun,
    markAnalysisRunFailed,
} from '@/lib/services/analysisRuns';

export const runtime = 'nodejs';

const MOVE_CLASSIFICATIONS: readonly MoveClassification[] = [
    'brilliant',
    'great',
    'best',
    'excellent',
    'good',
    'book',
    'inaccuracy',
    'mistake',
    'blunder',
];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
    return isNonEmptyString(value) ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
    if (!isNonEmptyString(value)) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
    if (!isFiniteNumber(value)) return undefined;
    const n = Math.trunc(value);
    return n >= 0 ? n : undefined;
}

function isScore(value: unknown): boolean {
    if (value === null) return true;
    if (!isObject(value)) return false;
    return (
        (value.type === 'cp' || value.type === 'mate') &&
        isFiniteNumber(value.value)
    );
}

function isAnalyzedMove(value: unknown): boolean {
    if (!isObject(value)) return false;
    return (
        isFiniteNumber(value.ply) &&
        value.ply >= 0 &&
        isNonEmptyString(value.san) &&
        isNonEmptyString(value.uci) &&
        MOVE_CLASSIFICATIONS.includes(value.classification as MoveClassification) &&
        isScore(value.evalBefore) &&
        isScore(value.evalAfter) &&
        isFiniteNumber(value.cpLoss) &&
        (value.accuracy === undefined ||
            (isFiniteNumber(value.accuracy) &&
                value.accuracy >= 0 &&
                value.accuracy <= 100)) &&
        (value.bestMoveUci === undefined || isNonEmptyString(value.bestMoveUci)) &&
        (value.bestMoveSan === undefined || isNonEmptyString(value.bestMoveSan)) &&
        (value.hasPuzzle === undefined || typeof value.hasPuzzle === 'boolean') &&
        (value.puzzleId === undefined || isNonEmptyString(value.puzzleId)) &&
        (value.puzzleType === undefined ||
            value.puzzleType === 'avoidBlunder' ||
            value.puzzleType === 'punishBlunder')
    );
}

function isGameAnalysis(value: unknown): value is GameAnalysis {
    if (!isObject(value)) return false;
    return (
        isNonEmptyString(value.gameId) &&
        Array.isArray(value.moves) &&
        value.moves.every(isAnalyzedMove) &&
        isNonEmptyString(value.analyzedAt) &&
        (value.whiteAccuracy === undefined ||
            (isFiniteNumber(value.whiteAccuracy) &&
                value.whiteAccuracy >= 0 &&
                value.whiteAccuracy <= 100)) &&
        (value.blackAccuracy === undefined ||
            (isFiniteNumber(value.blackAccuracy) &&
                value.blackAccuracy >= 0 &&
                value.blackAccuracy <= 100))
    );
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as unknown;
    if (!isObject(body) || !isGameAnalysis(body.analysis)) {
        return NextResponse.json(
            { error: 'Invalid analysis' },
            { status: 400 }
        );
    }

    const puzzleValidation = validatePuzzleReplacementBody(body);
    if (!puzzleValidation.ok) {
        return NextResponse.json(
            { error: puzzleValidation.error },
            { status: 400 }
        );
    }

    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true, provider: true, externalId: true },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const analysis = body.analysis;
    const normalizedGameId = `${providerToUi(game.provider)}:${game.externalId}`;
    if (analysis.gameId !== normalizedGameId) {
        return NextResponse.json(
            { error: 'Analysis game mismatch' },
            { status: 400 }
        );
    }
    if (
        puzzleValidation.puzzles.some(
            (puzzle) => puzzle.sourceGameId !== normalizedGameId
        )
    ) {
        return NextResponse.json(
            { error: 'Puzzle game mismatch' },
            { status: 400 }
        );
    }

    let analysisRunId: string | null = null;
    try {
        const bodyRecord = body as Record<string, unknown>;
        const engine = isObject(bodyRecord.engine) ? bodyRecord.engine : {};
        const run = await createAnalysisRun({
            userId,
            gameId: id,
            executionMode: 'LOCAL_BROWSER',
            status: 'RUNNING',
            queuedReason: optionalString(bodyRecord.queuedReason),
            engine: {
                name:
                    optionalString(engine.name) ??
                    optionalString(bodyRecord.engineName),
                version:
                    optionalString(engine.version) ??
                    optionalString(bodyRecord.engineVersion),
                source:
                    optionalString(engine.source) ??
                    optionalString(bodyRecord.engineSource) ??
                    'local-browser',
            },
            appVersion: optionalString(bodyRecord.appVersion),
            configSnapshot:
                bodyRecord.configSnapshot ??
                bodyRecord.analysisConfigSnapshot ??
                {},
            configHash:
                optionalString(bodyRecord.configHash) ??
                optionalString(bodyRecord.analysisConfigHash),
            startedAt: optionalDate(bodyRecord.startedAt) ?? new Date(),
            consumedCredits: optionalNonNegativeInt(bodyRecord.consumedCredits) ?? 0,
        });
        analysisRunId = run.id;

        const result = await completeAnalysisRunWithGameAnalysis({
            runId: run.id,
            userId,
            gameId: id,
            analysis,
            puzzles: puzzleValidation.puzzles,
        });

        return NextResponse.json({
            ok: true,
            ...result,
            analysisRun: {
                id: result.run.id,
                executionMode: result.run.executionMode,
                status: result.run.status,
                configHash: result.run.configHash,
            },
        });
    } catch (error) {
        if (analysisRunId) {
            await markAnalysisRunFailed({ runId: analysisRunId, error }).catch(
                () => undefined
            );
        }
        return NextResponse.json(
            { error: 'Failed to save analysis' },
            { status: 500 }
        );
    }
}
