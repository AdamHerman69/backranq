import type { GameAnalysis } from '@/lib/analysis/classification';
import type { Puzzle } from '@/lib/analysis/puzzles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type AnalysisRouteModule = typeof import('@/app/api/games/[id]/analysis/route');
type PrismaMockWithTransaction = typeof prismaMock & {
    $transaction: ReturnType<typeof vi.fn>;
};

const ownedGame = {
    id: 'game-1',
    provider: 'LICHESS',
    externalId: 'source-game-1',
};

const validAnalysis: GameAnalysis = {
    gameId: 'lichess:source-game-1',
    analyzedAt: '2026-07-04T12:00:00.000Z',
    whiteAccuracy: 91.2,
    blackAccuracy: 84.5,
    moves: [
        {
            ply: 0,
            san: 'e4',
            uci: 'e2e4',
            classification: 'best',
            evalBefore: { type: 'cp', value: 20 },
            evalAfter: { type: 'cp', value: 18 },
            cpLoss: 2,
            accuracy: 99,
            bestMoveUci: 'e2e4',
            bestMoveSan: 'e4',
        },
    ],
};

const validPuzzle: Puzzle = {
    id: 'puzzle-1',
    type: 'blunder',
    mode: 'avoidBlunder',
    provider: 'lichess',
    sourceGameId: 'lichess:source-game-1',
    sourcePly: 12,
    playedAt: '2026-07-04T12:00:00.000Z',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    sideToMove: 'w',
    bestLineUci: ['e2e4', 'e7e5'],
    bestMoveUci: 'e2e4',
    score: { type: 'cp', value: 42 },
    label: 'Find the best move',
    tags: ['opening'],
};

async function importRoute(): Promise<AnalysisRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();

    return import('@/app/api/games/[id]/analysis/route');
}

function createPutRequest(body: Parameters<typeof createJsonRequest>[1]) {
    return createJsonRequest('http://localhost/api/games/game-1/analysis', body, {
        method: 'PUT',
    });
}

function routeParams() {
    return { params: Promise.resolve({ id: 'game-1' }) };
}

describe('PUT /api/games/[id]/analysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn();
    });

    it('rejects malformed bodies before any write', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({ analysis: null, puzzles: [] }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects games owned by another user before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(null);

        const response = await route.PUT(
            createPutRequest({ analysis: validAnalysis, puzzles: [] }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
        expect(response.status).toBe(404);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
    });

    it('rejects invalid puzzles before any write', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                puzzles: [{ ...validPuzzle, sourcePly: -1 }],
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid puzzles',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects analysis for a different source game before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: { ...validAnalysis, gameId: 'lichess:other-game' },
                puzzles: [],
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Analysis game mismatch',
        });
        expect(response.status).toBe(400);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
    });

    it('rejects puzzles for a different source game before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                puzzles: [
                    { ...validPuzzle, sourceGameId: 'lichess:other-game' },
                ],
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Puzzle game mismatch',
        });
        expect(response.status).toBe(400);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
    });

    it('allows empty puzzle arrays and saves analysis atomically', async () => {
        const route = await importRoute();
        const analyzedAt = new Date('2026-07-04T12:30:00.000Z');
        const tx = {
            analyzedGame: {
                update: vi.fn().mockResolvedValue({ id: 'game-1', analyzedAt }),
            },
            puzzle: {
                upsert: vi.fn(),
                updateMany: vi.fn().mockResolvedValue({ count: 3 }),
            },
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
            async (callback) => callback(tx)
        );

        const response = await route.PUT(
            createPutRequest({ analysis: validAnalysis, puzzles: [] }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            ok: true,
            game: { id: 'game-1', analyzedAt: analyzedAt.toISOString() },
            puzzles: { upserted: 0, staleArchived: 3 },
        });
        expect(response.status).toBe(200);
        expect(tx.analyzedGame.update).toHaveBeenCalledWith({
            where: { id: 'game-1' },
            data: {
                analysis: validAnalysis,
                analyzedAt: expect.any(Date),
            },
            select: { id: true, analyzedAt: true },
        });
        expect(tx.puzzle.upsert).not.toHaveBeenCalled();
        expect(tx.puzzle.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                gameId: 'game-1',
                archivedAt: null,
            },
            data: { archivedAt: expect.any(Date) },
        });
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
    });

    it('returns failure when a transaction write fails without top-level writes', async () => {
        const route = await importRoute();
        const tx = {
            analyzedGame: {
                update: vi.fn().mockResolvedValue({
                    id: 'game-1',
                    analyzedAt: new Date('2026-07-04T12:30:00.000Z'),
                }),
            },
            puzzle: {
                upsert: vi.fn().mockRejectedValue(new Error('database failed')),
                updateMany: vi.fn(),
            },
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
            async (callback) => callback(tx)
        );

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                puzzles: [validPuzzle],
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Failed to save analysis',
        });
        expect(response.status).toBe(500);
        expect(tx.analyzedGame.update).toHaveBeenCalled();
        expect(tx.puzzle.upsert).toHaveBeenCalled();
        expect(tx.puzzle.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.upsert).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
    });
});
