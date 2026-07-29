import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type {
    GameAnalysis,
    MoveClassification,
} from '@/lib/analysis/classification';
import { providerToUi } from '@/lib/api/games';
import {
    AnalysisConfigHashMismatchError,
    createAndCompleteLocalAnalysisRun,
    hashAnalysisConfig,
    SourcePgnChangedError,
} from '@/lib/services/analysisRuns';
import { Chess } from 'chess.js';
import { moveToUci } from '@/lib/chess/utils';
import {
    boundedJsonBody,
    isStrictIsoInstant,
} from '@/lib/api/validation';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    trainingMomentCandidatesMatchSource,
    validateTrainingMomentCandidates,
} from '@/lib/training/candidateValidation';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2_000_000;
const MAX_ANALYZED_PLIES = 2_048;
const MAX_CONFIG_BYTES = 64_000;
const MAX_TRAINING_MOMENTS = 2_048;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

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

function isNonEmptyString(
    value: unknown,
    maxLength = Number.POSITIVE_INFINITY
): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength
    );
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(value: unknown, maxLength = 512): string | undefined {
    return isNonEmptyString(value, maxLength) ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
    return isStrictIsoInstant(value) ? new Date(value) : undefined;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
    if (!isFiniteNumber(value)) return undefined;
    const n = Math.trunc(value);
    return n >= 0 && n <= 10_000 ? n : undefined;
}

function isScore(value: unknown): boolean {
    if (value === null) return true;
    if (!isObject(value)) return false;
    if (!isFiniteNumber(value.value)) return false;
    if (value.type === 'cp') {
        return value.value >= -100_000 && value.value <= 100_000;
    }
    if (value.type === 'mate') {
        return (
            Number.isSafeInteger(value.value) &&
            value.value >= -2_048 &&
            value.value <= 2_048
        );
    }
    return false;
}

function isAnalyzedMove(value: unknown): boolean {
    if (!isObject(value)) return false;
    return (
        typeof value.ply === 'number' &&
        Number.isSafeInteger(value.ply) &&
        value.ply >= 0 &&
        value.ply < MAX_ANALYZED_PLIES &&
        isNonEmptyString(value.san, 64) &&
        isNonEmptyString(value.uci, 5) &&
        UCI_RE.test(value.uci.trim().toLowerCase()) &&
        MOVE_CLASSIFICATIONS.includes(value.classification as MoveClassification) &&
        isScore(value.evalBefore) &&
        isScore(value.evalAfter) &&
        isFiniteNumber(value.cpLoss) &&
        value.cpLoss >= 0 &&
        value.cpLoss <= 200_000 &&
        (value.accuracy === undefined ||
            (isFiniteNumber(value.accuracy) &&
                value.accuracy >= 0 &&
                value.accuracy <= 100)) &&
        (value.bestMoveUci === undefined ||
            (isNonEmptyString(value.bestMoveUci, 5) &&
                UCI_RE.test(value.bestMoveUci.trim().toLowerCase()))) &&
        (value.bestMoveSan === undefined ||
            isNonEmptyString(value.bestMoveSan, 64)) &&
        (value.hasTrainingMoment === undefined ||
            typeof value.hasTrainingMoment === 'boolean') &&
        (value.trainingMomentSource === undefined ||
            value.trainingMomentSource === 'MY_MISTAKE' ||
            value.trainingMomentSource === 'MISSED_OPPORTUNITY')
    );
}

function isGameAnalysis(value: unknown): value is GameAnalysis {
    if (!isObject(value)) return false;
    return (
        isNonEmptyString(value.gameId, 512) &&
        Array.isArray(value.moves) &&
        value.moves.length <= MAX_ANALYZED_PLIES &&
        value.moves.every(
            (move, index) =>
                isAnalyzedMove(move) &&
                (move as Record<string, unknown>).ply === index
        ) &&
        isNonEmptyString(value.analyzedAt, 64) &&
        isStrictIsoInstant(value.analyzedAt) &&
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

function validateExtractionManifest(
    value: unknown
): ExtractionCompletionManifest | null {
    if (
        !isObject(value) ||
        value.version !== 1 ||
        value.complete !== true ||
        typeof value.sourceGameId !== 'string' ||
        typeof value.sourcePgnHash !== 'string' ||
        !Number.isSafeInteger(value.scannedPlies) ||
        !Number.isSafeInteger(value.expectedPlies) ||
        (value.scannedPlies as number) < 0 ||
        value.scannedPlies !== value.expectedPlies ||
        value.termination !== 'COMPLETED' ||
        !Array.isArray(value.errors) ||
        value.errors.length !== 0
    ) {
        return null;
    }
    return value as ExtractionCompletionManifest;
}

function analysisMatchesPgn(analysis: GameAnalysis, pgn: string): boolean {
    try {
        const chess = new Chess();
        chess.loadPgn(pgn);
        const history = chess.history({ verbose: true });
        if (history.length !== analysis.moves.length) return false;
        return history.every((move, index) => {
            const analyzed = analysis.moves[index];
            return (
                analyzed?.ply === index &&
                analyzed.uci.trim().toLowerCase() ===
                    moveToUci(move).toLowerCase()
            );
        });
    } catch {
        return false;
    }
}

function hasBoundedJsonSize(value: unknown, maxBytes: number): boolean {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
    } catch {
        return false;
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsedBody = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error },
            { status: parsedBody.status ?? 400 }
        );
    }

    const { id } = await params;
    const body = parsedBody.value;
    if (!isObject(body) || !isGameAnalysis(body.analysis)) {
        return NextResponse.json(
            { error: 'Invalid analysis' },
            { status: 400 }
        );
    }

    const trainingMomentValidation = validateTrainingMomentCandidates(
        body.trainingMoments,
        MAX_TRAINING_MOMENTS
    );
    if (!trainingMomentValidation.ok) {
        return NextResponse.json(
            { error: trainingMomentValidation.error },
            { status: 400 }
        );
    }
    const bodyRecord = body as Record<string, unknown>;
    const extractionManifest = validateExtractionManifest(
        bodyRecord.extractionManifest
    );
    if (!extractionManifest) {
        return NextResponse.json(
            { error: 'Invalid extraction manifest' },
            { status: 400 }
        );
    }
    const configSnapshot =
        bodyRecord.configSnapshot ?? bodyRecord.analysisConfigSnapshot ?? {};
    if (!isObject(configSnapshot)) {
        return NextResponse.json(
            { error: 'Invalid configSnapshot' },
            { status: 400 }
        );
    }
    if (!hasBoundedJsonSize(configSnapshot, MAX_CONFIG_BYTES)) {
        return NextResponse.json(
            { error: 'configSnapshot is too large' },
            { status: 413 }
        );
    }
    if (
        'startedAt' in bodyRecord &&
        !isStrictIsoInstant(bodyRecord.startedAt)
    ) {
        return NextResponse.json(
            { error: 'Invalid startedAt' },
            { status: 400 }
        );
    }
    if (
        'consumedCredits' in bodyRecord &&
        bodyRecord.consumedCredits !== 0
    ) {
        return NextResponse.json(
            { error: 'Local analysis consumedCredits must be 0' },
            { status: 400 }
        );
    }
    if ('engine' in bodyRecord && !isObject(bodyRecord.engine)) {
        return NextResponse.json(
            { error: 'Invalid engine provenance' },
            { status: 400 }
        );
    }
    if (
        isObject(bodyRecord.engine) &&
        'options' in bodyRecord.engine &&
        (!isObject(bodyRecord.engine.options) ||
            !hasBoundedJsonSize(bodyRecord.engine.options, 8_192))
    ) {
        return NextResponse.json(
            { error: 'Invalid engine options' },
            { status: 400 }
        );
    }
    const suppliedConfigHash =
        optionalString(bodyRecord.configHash) ??
        optionalString(bodyRecord.analysisConfigHash);
    const computedConfigHash = hashAnalysisConfig(configSnapshot);
    if (suppliedConfigHash && suppliedConfigHash !== computedConfigHash) {
        return NextResponse.json(
            { error: 'configHash does not match configSnapshot' },
            { status: 400 }
        );
    }

    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: {
            id: true,
            provider: true,
            externalId: true,
            playedAt: true,
            pgn: true,
        },
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
    if (!analysisMatchesPgn(analysis, game.pgn)) {
        return NextResponse.json(
            { error: 'Analysis does not match source PGN' },
            { status: 400 }
        );
    }
    if (
        !trainingMomentCandidatesMatchSource({
            moments: trainingMomentValidation.moments,
            gameId: id,
            provider: providerToUi(game.provider),
            playedAt: game.playedAt,
            pgn: game.pgn,
            configHash: computedConfigHash,
        })
    ) {
        return NextResponse.json(
            {
                error: 'Training moments do not match source game positions',
            },
            { status: 400 }
        );
    }
    if (
        extractionManifest.sourceGameId !== id ||
        extractionManifest.sourcePgnHash !== hashSourcePgn(game.pgn) ||
        extractionManifest.expectedPlies !== analysis.moves.length
    ) {
        return NextResponse.json(
            { error: 'Extraction manifest mismatch' },
            { status: 400 }
        );
    }

    try {
        const engine = isObject(bodyRecord.engine) ? bodyRecord.engine : {};
        const result = await createAndCompleteLocalAnalysisRun({
            run: {
                userId,
                gameId: id,
                executionMode: 'LOCAL_BROWSER',
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
                    flavor: optionalString(engine.flavor),
                    evalFile: optionalString(engine.evalFile, 512),
                    options:
                        isObject(engine.options) &&
                        hasBoundedJsonSize(engine.options, 8_192)
                            ? engine.options
                            : {},
                },
                appVersion: optionalString(bodyRecord.appVersion),
                configSnapshot,
                configHash: computedConfigHash,
                inputPgnHash: hashSourcePgn(game.pgn),
                startedAt: optionalDate(bodyRecord.startedAt) ?? new Date(),
                consumedCredits:
                    optionalNonNegativeInt(bodyRecord.consumedCredits) ?? 0,
            },
            completion: {
                userId,
                gameId: id,
                analysis,
                trainingMoments: trainingMomentValidation.moments,
                extractionManifest,
            },
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
        if (error instanceof SourcePgnChangedError) {
            return NextResponse.json(
                { error: 'Source PGN changed during analysis; retry analysis' },
                { status: 409 }
            );
        }
        if (error instanceof AnalysisConfigHashMismatchError) {
            return NextResponse.json(
                { error: error.message },
                { status: 400 }
            );
        }
        return NextResponse.json(
            { error: 'Failed to save analysis' },
            { status: 500 }
        );
    }
}
