import type { Puzzle } from '@/lib/analysis/puzzles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type PuzzlesRouteModule = typeof import('@/app/api/games/[id]/puzzles/route');
type PrismaMockWithTransaction = typeof prismaMock & {
    $transaction: ReturnType<typeof vi.fn>;
};

const ownedGame = {
    id: 'game-1',
    provider: 'LICHESS',
    externalId: 'source-game-1',
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

async function importRoute(): Promise<PuzzlesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();

    return import('@/app/api/games/[id]/puzzles/route');
}

function createPutRequest(body: Parameters<typeof createJsonRequest>[1]) {
    return createJsonRequest('http://localhost/api/games/game-1/puzzles', body, {
        method: 'PUT',
    });
}

describe('PUT /api/games/[id]/puzzles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn();
    });

    it('rejects missing puzzles before any puzzle replacement', async () => {
        const route = await importRoute();
        const response = await route.PUT(createPutRequest({}), {
            params: Promise.resolve({ id: 'game-1' }),
        });

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid puzzles',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects malformed puzzles before any puzzle replacement', async () => {
        const route = await importRoute();
        const response = await route.PUT(createPutRequest({ puzzles: null }), {
            params: Promise.resolve({ id: 'game-1' }),
        });

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid puzzles',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects invalid puzzle items before any puzzle replacement', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                puzzles: [validPuzzle, { ...validPuzzle, bestLineUci: [null] }],
            }),
            { params: Promise.resolve({ id: 'game-1' }) }
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid puzzles',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('allows explicit empty puzzle arrays to archive existing puzzles', async () => {
        const route = await importRoute();
        const tx = {
            puzzle: {
                updateMany: vi.fn().mockResolvedValue({ count: 2 }),
                upsert: vi.fn(),
            },
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
            async (callback) => callback(tx)
        );

        const response = await route.PUT(createPutRequest({ puzzles: [] }), {
            params: Promise.resolve({ id: 'game-1' }),
        });

        await expect(readJson(response)).resolves.toEqual({
            ok: true,
            deleted: true,
            created: 0,
            upserted: 0,
            staleArchived: 2,
        });
        expect(response.status).toBe(200);
        expect(tx.puzzle.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                gameId: 'game-1',
                archivedAt: null,
            },
            data: { archivedAt: expect.any(Date) },
        });
        expect(tx.puzzle.upsert).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects puzzles for a different source game before replacement', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                puzzles: [
                    { ...validPuzzle, sourceGameId: 'lichess:other-game' },
                ],
            }),
            { params: Promise.resolve({ id: 'game-1' }) }
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Puzzle game mismatch',
        });
        expect(response.status).toBe(400);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.puzzle.deleteMany).not.toHaveBeenCalled();
    });
});
