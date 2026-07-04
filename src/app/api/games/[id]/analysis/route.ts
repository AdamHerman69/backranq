import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type {
    GameAnalysis,
    MoveClassification,
} from '@/lib/analysis/classification';
import { gameAnalysisToJson, providerToUi } from '@/lib/api/games';
import { Prisma } from '@prisma/client';
import { validatePuzzleReplacementBody } from '../puzzles/validation';
import { replaceGamePuzzlesInTransaction } from '@/lib/api/puzzlePersistence';

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

    try {
        const result = await prisma.$transaction(async (tx) => {
            const updatedGame = await tx.analyzedGame.update({
                where: { id },
                data: {
                    analysis: gameAnalysisToJson(analysis) as Prisma.InputJsonValue,
                    analyzedAt: new Date(),
                },
                select: { id: true, analyzedAt: true },
            });
            const puzzles = await replaceGamePuzzlesInTransaction({
                tx,
                userId,
                gameId: id,
                puzzles: puzzleValidation.puzzles,
            });

            return { game: updatedGame, puzzles };
        });

        return NextResponse.json({ ok: true, ...result });
    } catch {
        return NextResponse.json(
            { error: 'Failed to save analysis' },
            { status: 500 }
        );
    }
}
