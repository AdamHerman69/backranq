import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';
import {
    PUZZLE_ATTEMPT_REVEALED_SENTINEL,
    PUZZLE_ATTEMPT_SKIPPED_SENTINEL,
} from '@/lib/puzzles/attemptOutcomes';

type AttemptRouteModule =
    typeof import('@/app/api/puzzles/[id]/attempt/route');

const puzzleId = '11111111-1111-4111-8111-111111111111';
const clientAttemptId = '22222222-2222-4222-8222-222222222222';

async function importRoute(): Promise<AttemptRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/puzzles/[id]/attempt/route');
}

function request(body?: Record<string, unknown>) {
    return createJsonRequest(
        `http://localhost/api/puzzles/${puzzleId}/attempt`,
        body ?? {
            clientAttemptId,
            userMoveUci: 'e2e4',
            wasCorrect: true,
            timeSpentMs: 1000,
        },
        { method: 'POST' }
    );
}

describe('POST /api/puzzles/[id]/attempt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.puzzle.findFirst.mockResolvedValue({
            id: puzzleId,
            bestMoveUci: 'e2e4',
            acceptedMovesUci: [],
        });
        prismaMock.puzzleAttempt.findMany.mockResolvedValue([
            {
                wasCorrect: true,
                attemptedAt: new Date('2026-07-27T00:00:00.000Z'),
                timeSpentMs: 1000,
            },
        ]);
    });

    it('stores duplicate clientAttemptId only once', async () => {
        const route = await importRoute();
        prismaMock.puzzleAttempt.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                puzzleId,
                userId: 'user-1',
                userMoveUci: 'e2e4',
                wasCorrect: true,
                timeSpentMs: 1000,
            });
        prismaMock.puzzleAttempt.create.mockResolvedValue({
            id: clientAttemptId,
        });

        const first = await route.POST(request(), {
            params: Promise.resolve({ id: puzzleId }),
        });
        const second = await route.POST(request(), {
            params: Promise.resolve({ id: puzzleId }),
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        await expect(readJson(first)).resolves.toMatchObject({
            ok: true,
            idempotent: false,
        });
        await expect(readJson(second)).resolves.toMatchObject({
            ok: true,
            idempotent: true,
        });
        expect(prismaMock.puzzleAttempt.create).toHaveBeenCalledTimes(1);
        expect(prismaMock.puzzleAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: clientAttemptId,
                puzzleId,
                userId: 'user-1',
            }),
        });
    });

    it('rejects an idempotency key owned by another user', async () => {
        const route = await importRoute();
        prismaMock.puzzleAttempt.findUnique.mockResolvedValue({
            puzzleId,
            userId: 'user-2',
            userMoveUci: 'e2e4',
            wasCorrect: true,
            timeSpentMs: 1000,
        });

        const response = await route.POST(request(), {
            params: Promise.resolve({ id: puzzleId }),
        });

        expect(response.status).toBe(409);
        expect(prismaMock.puzzleAttempt.create).not.toHaveBeenCalled();
    });

    it('rejects reuse of clientAttemptId with a different move', async () => {
        const route = await importRoute();
        prismaMock.puzzleAttempt.findUnique.mockResolvedValue({
            puzzleId,
            userId: 'user-1',
            userMoveUci: 'd2d4',
            wasCorrect: false,
            timeSpentMs: 1000,
        });

        const response = await route.POST(request(), {
            params: Promise.resolve({ id: puzzleId }),
        });

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'clientAttemptId payload conflict',
        });
        expect(prismaMock.puzzleAttempt.create).not.toHaveBeenCalled();
    });

    it.each([
        ['revealed', PUZZLE_ATTEMPT_REVEALED_SENTINEL],
        ['skipped', PUZZLE_ATTEMPT_SKIPPED_SENTINEL],
    ] as const)('persists an idempotent %s outcome event', async (outcome, sentinel) => {
        const route = await importRoute();
        prismaMock.puzzleAttempt.findUnique.mockResolvedValue(null);
        prismaMock.puzzleAttempt.create.mockResolvedValue({
            id: clientAttemptId,
        });
        prismaMock.puzzleAttempt.findMany.mockResolvedValue([
            {
                userMoveUci: sentinel,
                wasCorrect: false,
                attemptedAt: new Date('2026-07-27T00:00:00.000Z'),
                timeSpentMs: 500,
            },
        ]);

        const response = await route.POST(
            request({
                clientAttemptId,
                outcome,
                timeSpentMs: 500,
            }),
            { params: Promise.resolve({ id: puzzleId }) }
        );
        const body = await readJson<{
            outcome: string;
            attemptStats: { outcome: string; solved: boolean };
        }>(response);

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            outcome,
            attemptStats: { outcome, solved: false },
        });
        expect(prismaMock.puzzleAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: clientAttemptId,
                userMoveUci: sentinel,
                wasCorrect: false,
            }),
        });
    });

    it('stores a correct move after reveal as non-solving practice', async () => {
        const route = await importRoute();
        prismaMock.puzzleAttempt.findUnique.mockResolvedValue(null);
        prismaMock.puzzleAttempt.findFirst.mockResolvedValue({
            id: 'outcome-attempt',
            userMoveUci: PUZZLE_ATTEMPT_REVEALED_SENTINEL,
        });
        prismaMock.puzzleAttempt.create.mockResolvedValue({
            id: clientAttemptId,
        });
        prismaMock.puzzleAttempt.findMany.mockResolvedValue([
            {
                userMoveUci: PUZZLE_ATTEMPT_REVEALED_SENTINEL,
                wasCorrect: false,
                attemptedAt: new Date('2026-07-27T00:00:00.000Z'),
                timeSpentMs: 500,
            },
            {
                userMoveUci: 'e2e4',
                wasCorrect: false,
                attemptedAt: new Date('2026-07-27T00:01:00.000Z'),
                timeSpentMs: 1000,
            },
        ]);

        const response = await route.POST(request(), {
            params: Promise.resolve({ id: puzzleId }),
        });
        const body = await readJson<{
            attemptStats: { outcome: string; solved: boolean; correct: number };
        }>(response);

        expect(response.status).toBe(200);
        expect(prismaMock.puzzleAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userMoveUci: 'e2e4',
                wasCorrect: false,
            }),
        });
        expect(body.attemptStats).toMatchObject({
            outcome: 'revealed',
            solved: false,
            correct: 0,
        });
    });

    it.each([
        [{ clientAttemptId, userMoveUci: 'not-a-move' }, 'Invalid userMoveUci'],
        [
            {
                clientAttemptId,
                userMoveUci: 'e2e4',
                timeSpentMs: 24 * 60 * 60 * 1000 + 1,
            },
            'Invalid timeSpentMs',
        ],
        [
            {
                clientAttemptId,
                outcome: 'unknown',
            },
            'Invalid outcome',
        ],
    ])('rejects invalid or oversized activity payloads', async (payload, error) => {
        const route = await importRoute();

        const response = await route.POST(request(payload), {
            params: Promise.resolve({ id: puzzleId }),
        });

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({ error });
        expect(prismaMock.puzzleAttempt.create).not.toHaveBeenCalled();
    });
});
