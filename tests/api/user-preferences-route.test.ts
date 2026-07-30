import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type PreferencesRouteModule = typeof import('@/app/api/user/preferences/route');
const scheduleAutoAnalysisWakeupMock = vi.fn();

async function importRoute(): Promise<PreferencesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        scheduleAutoAnalysisWakeup: scheduleAutoAnalysisWakeupMock,
    }));
    return import('@/app/api/user/preferences/route');
}

function createPutRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/user/preferences', body, {
        method: 'PUT',
        headers: {
            [EXPECTED_OWNER_HEADER]: 'user-1',
        },
    });
}

describe('PUT /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.user.update.mockResolvedValue({ id: 'user-1' });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );
    });

    it('rejects a missing or stale expected owner before parsing or writing', async () => {
        const route = await importRoute();
        const malformedBody = '{';

        const missing = await route.PUT(
            new Request('http://localhost/api/user/preferences', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: malformedBody,
            })
        );
        const stale = await route.PUT(
            new Request('http://localhost/api/user/preferences', {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: 'user-a',
                },
                body: malformedBody,
            })
        );

        expect(missing.status).toBe(409);
        expect(stale.status).toBe(409);
        await expect(readJson(stale)).resolves.toMatchObject({
            code: 'OWNER_MISMATCH',
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
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
        const body = await readJson<{
            ownerId: string;
            preferences: Record<string, unknown>;
        }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body.ownerId).toBe('user-1');
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
                autoAnalysis: { enabled: true },
                autoSyncProviders: { lichess: true, chesscom: false },
            })
        );
        const body = await readJson<{
            ownerId: string;
            preferences: Record<string, unknown>;
        }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body.ownerId).toBe('user-1');
        expect(body.preferences).toMatchObject({
            autoSyncEnabled: false,
            autoSyncProviders: { lichess: true, chesscom: false },
            autoAnalysis: expect.objectContaining({ enabled: true }),
        });
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    preferences: expect.objectContaining({
                        autoSyncEnabled: false,
                        autoSyncProviders: expect.objectContaining({
                            chesscom: false,
                        }),
                        autoAnalysis: expect.objectContaining({
                            enabled: true,
                        }),
                    }),
                },
            })
        );
    });

    it('validates and canonicalizes the complete auto-analysis policy', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({
                autoAnalysis: {
                    enabled: true,
                    providers: { lichess: true, chesscom: false },
                    timeControls: {
                        bullet: false,
                        blitz: false,
                        rapid: true,
                        classical: false,
                        unknown: false,
                    },
                    ratedOnly: true,
                    resultScope: 'losses',
                    minPlies: 12,
                    dailyCap: 3,
                    monthlyCap: 20,
                    reserveCredits: 0,
                    backlogMode: 'all',
                },
            })
        );
        const body = await readJson<{
            ownerId: string;
            preferences: {
                autoAnalysis: Record<string, unknown>;
            };
        }>(response);

        expect(response.status).toBe(200);
        expect(body.ownerId).toBe('user-1');
        expect(body.preferences.autoAnalysis).toMatchObject({
            enabled: true,
            reserveCredits: 0,
            backlogMode: 'all',
            enabledAt: expect.any(String),
        });
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'preferences'
        );
    });

    it('rejects unknown, server-controlled, and removed legacy automation fields', async () => {
        const route = await importRoute();

        const unknown = await route.PUT(
            createPutRequest({ autoAnalysis: { arbitrary: true } })
        );
        const timestamp = await route.PUT(
            createPutRequest({
                autoAnalysis: {
                    enabledAt: '2026-07-01T00:00:00.000Z',
                },
            })
        );
        const unknownTopLevel = await route.PUT(
            createPutRequest({ arbitraryAutomationFlag: true })
        );

        expect(unknown.status).toBe(400);
        expect(timestamp.status).toBe(400);
        expect(unknownTopLevel.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('enforces automation policy cross-field invariants', async () => {
        const route = await importRoute();

        const invertedCaps = await route.PUT(
            createPutRequest({
                autoAnalysis: { dailyCap: 20, monthlyCap: 10 },
            })
        );
        const noProviders = await route.PUT(
            createPutRequest({
                autoAnalysis: {
                    enabled: true,
                    providers: { lichess: false, chesscom: false },
                },
            })
        );

        expect(invertedCaps.status).toBe(400);
        expect(noProviders.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('disables policy and cancellation in one transaction', async () => {
        const route = await importRoute();
        const current = defaultAutoAnalysisEnabled();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: current,
        });
        prismaMock.analysisJob.findMany.mockResolvedValue([]);
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );

        const response = await route.PUT(
            createPutRequest({ autoAnalysis: { enabled: false } })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.$transaction).toHaveBeenCalledOnce();
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    preferences: expect.objectContaining({
                        autoAnalysis: expect.objectContaining({
                            enabled: false,
                        }),
                    }),
                },
            })
        );
    });

    it('wakes reconciliation after changing an enabled policy filter', async () => {
        const route = await importRoute();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: defaultAutoAnalysisEnabled(),
        });

        const response = await route.PUT(
            createPutRequest({
                autoAnalysis: { ratedOnly: false },
            })
        );

        expect(response.status).toBe(200);
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'preferences'
        );
    });

    it('sets a fresh eligibility boundary when an enabled policy changes from all to new', async () => {
        const route = await importRoute();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: defaultAutoAnalysisEnabled({
                backlogMode: 'all',
                enabledAt: '2026-07-01T00:00:00.000Z',
            }),
        });

        const response = await route.PUT(
            createPutRequest({
                autoAnalysis: { backlogMode: 'new' },
            })
        );
        const body = await readJson<{
            ownerId: string;
            preferences: {
                autoAnalysis: { backlogMode: string; enabledAt: string };
            };
        }>(response);

        expect(response.status).toBe(200);
        expect(body.preferences.autoAnalysis.backlogMode).toBe('new');
        expect(body.preferences.autoAnalysis.enabledAt).not.toBe(
            '2026-07-01T00:00:00.000Z'
        );
    });

    it('retries a serializable write conflict and merges against the newly committed preferences', async () => {
        const route = await importRoute();
        prismaMock.$transaction
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockImplementationOnce(
                async (callback: unknown) =>
                    (
                        callback as (
                            tx: typeof prismaMock
                        ) => Promise<unknown>
                    )(prismaMock)
            );
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                ...defaultAutoAnalysisEnabled(),
                analysisNodesPerPosition: '777777',
            },
        });

        const response = await route.PUT(
            createPutRequest({
                autoAnalysis: { ratedOnly: false },
            })
        );
        const body = await readJson<{
            preferences: {
                analysisNodesPerPosition: string;
                autoAnalysis: { ratedOnly: boolean };
            };
        }>(response);

        expect(response.status).toBe(200);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(body.preferences).toMatchObject({
            analysisNodesPerPosition: '777777',
            autoAnalysis: { ratedOnly: false },
        });
    });
});

describe('GET /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('returns the nested canonical policy', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                autoAnalysis: {
                    enabled: false,
                    providers: { lichess: false, chesscom: true },
                    timeControls: { blitz: true, rapid: false },
                },
            },
        });
        const route = await importRoute();

        const response = await route.GET();
        const body = await readJson<{
            ownerId: string;
            preferences: {
                autoAnalysis: {
                    enabled: boolean;
                    providers: Record<string, boolean>;
                    timeControls: Record<string, boolean>;
                };
            };
        }>(response);

        expect(body.ownerId).toBe('user-1');
        expect(body.preferences.autoAnalysis).toMatchObject({
            enabled: false,
            providers: { lichess: false, chesscom: true },
            timeControls: { blitz: true, rapid: false },
        });
    });
});

function defaultAutoAnalysisEnabled(
    overrides: Record<string, unknown> = {}
) {
    return {
        autoAnalysis: {
            enabled: true,
            providers: { lichess: true, chesscom: true },
            timeControls: {
                bullet: false,
                blitz: false,
                rapid: true,
                classical: true,
                unknown: false,
            },
            ratedOnly: true,
            resultScope: 'draws',
            minPlies: 20,
            dailyCap: 10,
            monthlyCap: 50,
            reserveCredits: 10,
            backlogMode: 'new',
            enabledAt: '2026-07-01T00:00:00.000Z',
            ...overrides,
        },
    };
}
