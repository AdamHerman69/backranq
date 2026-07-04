import type { Prisma } from '@prisma/client';
import type { Puzzle as UiPuzzle } from '@/lib/analysis/puzzles';
import { puzzleToDb } from '@/lib/api/puzzles';

type PuzzleTransactionClient = Pick<Prisma.TransactionClient, 'puzzle'>;

type PuzzleKey = {
    gameId: string;
    sourcePly: number;
    fen: string;
};

export type ReplaceGamePuzzlesResult = {
    upserted: number;
    staleArchived: number;
};

function puzzleKey(data: PuzzleKey): string {
    return `${data.gameId}\u0000${data.sourcePly}\u0000${data.fen}`;
}

function mutablePuzzleData(
    p: Prisma.PuzzleCreateManyInput
): Prisma.PuzzleUncheckedUpdateInput {
    return {
        type: p.type,
        kind: p.kind,
        phase: p.phase,
        severity: p.severity,
        bestMoveUci: p.bestMoveUci,
        acceptedMovesUci: Array.isArray(p.acceptedMovesUci)
            ? p.acceptedMovesUci
            : [],
        bestLine: p.bestLine,
        score: p.score,
        tags: Array.isArray(p.tags) ? p.tags : [],
        openingEco: p.openingEco,
        openingName: p.openingName,
        openingVariation: p.openingVariation,
        label: p.label,
        archivedAt: null,
    };
}

export async function replaceGamePuzzlesInTransaction(args: {
    tx: PuzzleTransactionClient;
    userId: string;
    gameId: string;
    puzzles: UiPuzzle[];
}): Promise<ReplaceGamePuzzlesResult> {
    const deduped = new Map<string, Prisma.PuzzleCreateManyInput>();
    for (const puzzle of args.puzzles) {
        const data = puzzleToDb({
            puzzle,
            userId: args.userId,
            gameId: args.gameId,
        });
        deduped.set(puzzleKey(data), data);
    }

    const intended = Array.from(deduped.values());
    for (const p of intended) {
        await args.tx.puzzle.upsert({
            where: {
                gameId_sourcePly_fen: {
                    gameId: p.gameId,
                    sourcePly: p.sourcePly,
                    fen: p.fen,
                },
            },
            create: p,
            update: mutablePuzzleData(p),
        });
    }

    const staleWhere: Prisma.PuzzleWhereInput = {
        userId: args.userId,
        gameId: args.gameId,
        archivedAt: null,
    };
    if (intended.length > 0) {
        staleWhere.NOT = {
            OR: intended.map((p) => ({
                sourcePly: p.sourcePly,
                fen: p.fen,
            })),
        };
    }

    const staleArchived = await args.tx.puzzle.updateMany({
        where: staleWhere,
        data: { archivedAt: new Date() },
    });

    return {
        upserted: intended.length,
        staleArchived: staleArchived.count,
    };
}
