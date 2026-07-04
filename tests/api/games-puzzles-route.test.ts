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

const validPuzzle: Puzzle = {
    id: 'puzzle-1',
    type: 'blunder',
    mode: 'avoidBlunder',
    provider: 'lichess',
    sourceGameId: 'game-1',
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

    it('allows explicit empty puzzle arrays to replace existing puzzles', async () => {
        const route = await importRoute();
        const tx = {
            puzzle: {
                deleteMany: vi.fn(),
                createMany: vi.fn(),
            },
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue({ id: 'game-1' });
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
        });
        expect(response.status).toBe(200);
        expect(tx.puzzle.deleteMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', gameId: 'game-1' },
        });
        expect(tx.puzzle.createMany).not.toHaveBeenCalled();
    });
});
