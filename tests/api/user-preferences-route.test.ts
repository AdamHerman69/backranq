import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type PreferencesRouteModule = typeof import('@/app/api/user/preferences/route');

async function importRoute(): Promise<PreferencesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/user/preferences/route');
}

function createPutRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/user/preferences', body, {
        method: 'PUT',
    });
}

describe('PUT /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('rejects unknown preference keys before writing', async () => {
        const route = await importRoute();

        const response = await route.PUT(createPutRequest({ admin: true }));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unknown preference admin',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects invalid patch shapes before writing', async () => {
        const route = await importRoute();

        const response = await route.PUT(createPutRequest(null));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid preferences patch',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects extraction settings that can exhaust a server worker', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({ analysisNodesPerPosition: '999999999' })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error:
                'Invalid analysisNodesPerPosition; expected 1000..10000000',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('requires integer values for engine settings', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({ themeLookaheadPlies: '3.5' })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid themeLookaheadPlies; expected 0..32',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('enforces total payload size before reading or writing preferences', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({
                unknownPreference: 'x'.repeat(260_000),
            })
        );

        expect(response.status).toBe(413);
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('requires strict calendar dates and bounded numeric filters', async () => {
        const route = await importRoute();

        const invalidDate = await route.PUT(
            createPutRequest({ filters: { since: '2026-02-30' } })
        );
        const invalidRating = await route.PUT(
            createPutRequest({ filters: { minElo: '5001' } })
        );
        const invalidLimit = await route.PUT(
            createPutRequest({ filters: { max: '1001' } })
        );

        expect(invalidDate.status).toBe(400);
        expect(invalidRating.status).toBe(400);
        expect(invalidLimit.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects inverted date and rating ranges', async () => {
        const route = await importRoute();

        const dateRange = await route.PUT(
            createPutRequest({
                filters: {
                    since: '2026-08-01',
                    until: '2026-07-01',
                },
            })
        );
        const ratingRange = await route.PUT(
            createPutRequest({
                filters: { minElo: '2000', maxElo: '1500' },
            })
        );

        expect(dateRange.status).toBe(400);
        expect(ratingRange.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects removed library state instead of accepting legacy records', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({ puzzles: [{ arbitrary: 'json' }] })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unknown preference puzzles',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects deprecated extraction preferences instead of adapting them', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({ puzzleMode: 'punishBlunder' })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unknown preference puzzleMode',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('validates the user-facing training controls', async () => {
        const route = await importRoute();

        const invalidCoverage = await route.PUT(
            createPutRequest({ trainingCoveragePreset: 'EVERYTHING' })
        );
        const invalidTolerance = await route.PUT(
            createPutRequest({ trainingGradingTolerance: 'ARBITRARY' })
        );
        const invalidMix = await route.PUT(
            createPutRequest({ trainingSessionMix: 'TACTICS_ONLY' })
        );

        expect(invalidCoverage.status).toBe(400);
        expect(invalidTolerance.status).toBe(400);
        expect(invalidMix.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('saves a validated partial preferences patch', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({
                analysisNodesPerPosition: '300000',
                confirmationNodes: '500000',
                themeLookaheadPlies: '6',
                trainingCoveragePreset: 'BALANCED',
                trainingGradingTolerance: 'LENIENT',
                trainingSessionMix: 'MY_MISTAKES',
                filters: { timeClass: 'rapid', max: '50' },
            })
        );
        const body = await readJson<{ preferences: Record<string, unknown> }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body.preferences).toMatchObject({
            analysisNodesPerPosition: '300000',
            confirmationNodes: '500000',
            themeLookaheadPlies: '6',
            trainingCoveragePreset: 'BALANCED',
            trainingGradingTolerance: 'LENIENT',
            trainingSessionMix: 'MY_MISTAKES',
            filters: expect.objectContaining({ timeClass: 'rapid', max: '50' }),
        });
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'user-1' },
                data: {
                    preferences: expect.objectContaining({
                        analysisNodesPerPosition: '300000',
                    }),
                },
            })
        );
    });

    it('validates and saves auto-sync preferences', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({
                autoSyncEnabled: false,
                autoAnalyzeEnabled: true,
                autoSyncProviders: { lichess: true, chesscom: false },
            })
        );
        const body = await readJson<{ preferences: Record<string, unknown> }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body.preferences).toMatchObject({
            autoSyncEnabled: false,
            autoAnalyzeEnabled: true,
            autoSyncProviders: { lichess: true, chesscom: false },
        });
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    preferences: expect.objectContaining({
                        autoSyncEnabled: false,
                        autoAnalyzeEnabled: true,
                        autoSyncProviders: expect.objectContaining({
                            chesscom: false,
                        }),
                    }),
                },
            })
        );
    });
});
