import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type GameRouteModule = typeof import('@/app/api/games/[id]/route');
const GAME_ID = '11111111-1111-4111-8111-111111111111';

async function importRoute(): Promise<GameRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/games/[id]/route');
}

function createGetRequest() {
    return new Request('http://localhost/api/games/game-1');
}

function createPatchRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/games/game-1', body, {
        method: 'PATCH',
    });
}

function createDeleteRequest() {
    return new Request('http://localhost/api/games/game-1', {
        method: 'DELETE',
    });
}

function routeParams() {
    return { params: Promise.resolve({ id: GAME_ID }) };
}

describe('GET /api/games/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('requires auth before reading a game', async () => {
        const route = await importRoute();
        setMockUserId(null);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects malformed UUIDs for every method before parsing or querying Prisma', async () => {
        const route = await importRoute();
        const invalidParams = {
            params: Promise.resolve({ id: 'not-a-uuid' }),
        };

        const getResponse = await route.GET(createGetRequest(), invalidParams);
        const patchResponse = await route.PATCH(
            new Request('http://localhost/api/games/not-a-uuid', {
                method: 'PATCH',
                body: 'not-json',
            }),
            invalidParams
        );
        const deleteResponse = await route.DELETE(
            createDeleteRequest(),
            invalidParams
        );

        expect(getResponse.status).toBe(400);
        expect(patchResponse.status).toBe(400);
        expect(deleteResponse.status).toBe(400);
        await expect(readJson(getResponse)).resolves.toEqual({
            error: 'Invalid game id',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('returns analysis in the game detail contract', async () => {
        const route = await importRoute();
        const analysis = { gameId: 'lichess:abc', moves: [] };
        const game = {
            id: GAME_ID,
            provider: 'LICHESS',
            externalId: 'abc',
            pgn: '[Event "Test"]',
            analysis,
            analyzedAt: '2026-07-04T12:00:00.000Z',
        };
        prismaMock.analyzedGame.findFirst.mockResolvedValue(game);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ game });
        expect(prismaMock.analyzedGame.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: GAME_ID, userId: 'user-1' },
                select: expect.objectContaining({
                    analysis: true,
                    analyzedAt: true,
                    pgn: true,
                }),
            })
        );
    });

    it('returns a consistent not found error', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(null);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
    });
});

describe('PATCH /api/games/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('does not allow callers to set analyzedAt', async () => {
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({
                analyzedAt: '2026-07-04T12:00:00.000Z',
            }),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'analyzedAt is managed by analysis completion',
        });
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
    });

    it('rejects PGN replacement while an analysis job is active', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: GAME_ID,
            provider: 'LICHESS',
            pgn: '[Event "Old"]',
        });
        prismaMock.analysisJob.findFirst.mockResolvedValue({ id: 'job-1' });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

        const response = await route.PATCH(
            createPatchRequest({ pgn: '[Event "New"]' }),
            routeParams()
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Cannot replace PGN while analysis is active',
        });
        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
    });

    it('rejects malformed PGN before any lookup or archival write', async () => {
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({ pgn: 'this is not PGN' }),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid pgn',
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it.each(['LICHESS', 'CHESSCOM'] as const)(
        'invalidates current analysis and active training moments when %s corrects its PGN',
        async (provider) => {
            const route = await importRoute();
            prismaMock.analyzedGame.findFirst.mockResolvedValue({
                id: GAME_ID,
                provider,
                pgn: '[Event "Old"]',
            });
            prismaMock.analysisJob.findFirst.mockResolvedValue(null);
            prismaMock.analyzedGame.updateMany.mockResolvedValue({ count: 1 });
            prismaMock.analyzedGame.findUniqueOrThrow.mockResolvedValue({
                id: GAME_ID,
                pgn: '[Event "New"]',
            });
            prismaMock.trainingMoment.updateMany.mockResolvedValue({ count: 2 });
            prismaMock.$transaction.mockImplementation(
                async (callback: unknown) =>
                    (
                        callback as (
                            tx: typeof prismaMock
                        ) => Promise<unknown>
                    )(prismaMock)
            );

            const response = await route.PATCH(
                createPatchRequest({ pgn: '[Event "New"]' }),
                routeParams()
            );

            expect(response.status).toBe(200);
            expect(prismaMock.analyzedGame.updateMany).toHaveBeenCalledWith({
                where: {
                    id: GAME_ID,
                    userId: 'user-1',
                    pgn: '[Event "Old"]',
                },
                data: expect.objectContaining({
                    pgn: '[Event "New"]',
                    analysis: {},
                    analyzedAt: null,
                    currentAnalysisRunId: null,
                }),
            });
            expect(prismaMock.trainingMoment.updateMany).toHaveBeenCalledWith({
                where: { gameId: GAME_ID, archivedAt: null },
                data: {
                    status: 'INVALIDATED',
                    archivedAt: expect.any(Date),
                },
            });
        }
    );

    it.each(['MANUAL_PGN', 'BACKRANQ_COACH'] as const)(
        'rejects %s PGN replacement as an immutable source snapshot before any write',
        async (provider) => {
            const route = await importRoute();
            prismaMock.analyzedGame.findFirst.mockResolvedValue({
                id: GAME_ID,
                provider,
                pgn: '[Event "Old"]',
            });
            prismaMock.$transaction.mockImplementation(
                async (callback: unknown) =>
                    (
                        callback as (
                            tx: typeof prismaMock
                        ) => Promise<unknown>
                    )(prismaMock)
            );

            const response = await route.PATCH(
                createPatchRequest({ pgn: '[Event "New"]' }),
                routeParams()
            );

            expect(response.status).toBe(409);
            await expect(readJson(response)).resolves.toEqual({
                error: 'Manual and Coach game PGN snapshots cannot be replaced.',
                code: 'IMMUTABLE_SOURCE_SNAPSHOT',
            });
            expect(prismaMock.analysisJob.findFirst).not.toHaveBeenCalled();
            expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
            expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
        }
    );

    it('maps a database local-source invariant violation to the same sanitized conflict', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: GAME_ID,
            provider: 'LICHESS',
            pgn: '[Event "Old"]',
        });
        prismaMock.analysisJob.findFirst.mockResolvedValue(null);
        prismaMock.analyzedGame.updateMany.mockRejectedValue(
            new Error(
                'constraint AnalyzedGame_local_source_pgn_immutable included internal database details'
            )
        );
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

        const response = await route.PATCH(
            createPatchRequest({ pgn: '[Event "New"]' }),
            routeParams()
        );
        const json = await readJson(response);

        expect(response.status).toBe(409);
        expect(json).toEqual({
            error: 'Manual and Coach game PGN snapshots cannot be replaced.',
            code: 'IMMUTABLE_SOURCE_SNAPSHOT',
        });
        expect(JSON.stringify(json)).not.toContain('internal database');
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/games/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('atomically cancels active analysis and deletes the game', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            id: GAME_ID,
        });
        prismaMock.analysisJob.findMany.mockResolvedValue([
            {
                id: 'job-1',
                status: 'RUNNING',
                analysisRunId: 'run-1',
                lastError: null,
                creditLedgerEntries: [],
            },
        ]);
        prismaMock.analysisJob.update.mockResolvedValue({ id: 'job-1' });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analyzedGame.deleteMany.mockResolvedValue({ count: 1 });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

        const response = await route.DELETE(createDeleteRequest(), routeParams());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            ok: true,
            cancelledJobs: 1,
            consumedReservations: 0,
            releasedReservations: 0,
        });
        expect(prismaMock.analysisJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: 'CANCELLED',
                lockedAt: null,
                lockedUntil: null,
            }),
        });
        expect(prismaMock.analyzedGame.deleteMany).toHaveBeenCalledWith({
            where: { id: GAME_ID, userId: 'user-1' },
        });
    });
});
