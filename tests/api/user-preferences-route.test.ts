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
const cancelQueuedAutoAnalysisJobsMock = vi.fn();

async function importRoute(): Promise<PreferencesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        scheduleAutoAnalysisWakeup: scheduleAutoAnalysisWakeupMock,
    }));
    vi.doMock('@/lib/services/analysisJobs', () => ({
        cancelQueuedAutoAnalysisJobsInTransaction:
            cancelQueuedAutoAnalysisJobsMock,
    }));
    return import('@/app/api/user/preferences/route');
}

function createPutRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/user/preferences', body, {
        method: 'PUT',
        headers: { [EXPECTED_OWNER_HEADER]: 'user-1' },
    });
}

function providerRules(mode: 'IGNORE' | 'IMPORT_ONLY' | 'AUTO_ANALYZE') {
    return {
        bullet: mode,
        blitz: mode,
        rapid: mode,
        classical: mode,
        unknown: mode,
    };
}

describe('PUT /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.user.update.mockResolvedValue({ id: 'user-1' });
        prismaMock.providerSyncState.updateMany.mockResolvedValue({ count: 1 });
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
    });

    it('rejects removed split automation fields instead of migrating them', async () => {
        const route = await importRoute();
        for (const body of [
            { autoSyncEnabled: false },
            { autoSyncProviders: { lichess: true } },
            { autoAnalysis: { enabled: true } },
        ]) {
            const response = await route.PUT(createPutRequest(body));
            expect(response.status).toBe(400);
        }
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('strictly validates automation providers, time controls and modes', async () => {
        const route = await importRoute();
        const unknownProvider = await route.PUT(
            createPutRequest({
                gameAutomation: { rules: { other: { rapid: 'IGNORE' } } },
            })
        );
        const unknownTime = await route.PUT(
            createPutRequest({
                gameAutomation: { rules: { lichess: { ultrabullet: 'IGNORE' } } },
            })
        );
        const badMode = await route.PUT(
            createPutRequest({
                gameAutomation: { rules: { lichess: { rapid: 'MAYBE' } } },
            })
        );

        expect(unknownProvider.status).toBe(400);
        expect(unknownTime.status).toBe(400);
        expect(badMode.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('keeps the automatic-analysis boundary server controlled', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                gameAutomation: {
                    analysis: { enabledAt: '2026-08-01T00:00:00.000Z' },
                },
            })
        );
        expect(response.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('saves the full unified matrix and resets changed import cursors', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                gameAutomation: {
                    paused: false,
                    rules: {
                        lichess: {
                            bullet: 'IGNORE',
                            blitz: 'IMPORT_ONLY',
                            rapid: 'AUTO_ANALYZE',
                            classical: 'AUTO_ANALYZE',
                            unknown: 'IGNORE',
                        },
                        chesscom: providerRules('IGNORE'),
                    },
                    analysis: {
                        resultScope: 'losses',
                        ratedOnly: false,
                        minPlies: 12,
                        dailyCap: 3,
                        monthlyCap: 20,
                        reserveCredits: 4,
                        existingGames: 'all',
                    },
                },
            })
        );
        const body = await readJson<{
            ownerId: string;
            preferences: {
                gameAutomation: {
                    rules: Record<string, Record<string, string>>;
                    analysis: { resultScope: string; enabledAt: string | null };
                };
            };
        }>(response);

        expect(response.status).toBe(200);
        expect(body.ownerId).toBe('user-1');
        expect(body.preferences.gameAutomation.rules.lichess).toMatchObject({
            bullet: 'IGNORE',
            blitz: 'IMPORT_ONLY',
            rapid: 'AUTO_ANALYZE',
        });
        expect(body.preferences.gameAutomation.analysis.resultScope).toBe(
            'losses'
        );
        expect(cancelQueuedAutoAnalysisJobsMock).toHaveBeenCalledWith({
            tx: prismaMock,
            userId: 'user-1',
        });
        expect(prismaMock.providerSyncState.updateMany).toHaveBeenCalledTimes(2);
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'preferences'
        );
    });

    it('sets a fresh boundary when automatic analysis is first enabled', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                gameAutomation: {
                    rules: { lichess: { rapid: 'AUTO_ANALYZE' } },
                    analysis: { existingGames: 'new' },
                },
            })
        );
        const body = await readJson<{
            preferences: {
                gameAutomation: { analysis: { enabledAt: string | null } };
            };
        }>(response);

        expect(response.status).toBe(200);
        expect(body.preferences.gameAutomation.analysis.enabledAt).toEqual(
            expect.any(String)
        );
    });

    it('does not wake analysis when all selected modes are import-only', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                gameAutomation: {
                    rules: { lichess: providerRules('IMPORT_ONLY') },
                },
            })
        );

        expect(response.status).toBe(200);
        expect(scheduleAutoAnalysisWakeupMock).not.toHaveBeenCalled();
    });

    it('rejects inverted personal analysis caps', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                gameAutomation: {
                    analysis: { dailyCap: 20, monthlyCap: 10 },
                },
            })
        );
        expect(response.status).toBe(400);
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('validates extraction settings independently', async () => {
        const route = await importRoute();
        const invalid = await route.PUT(
            createPutRequest({ analysisNodesPerPosition: '999999999' })
        );
        const valid = await route.PUT(
            createPutRequest({
                analysisNodesPerPosition: '300000',
                trainingCoveragePreset: 'BALANCED',
                filters: { timeClass: 'rapid', max: '50' },
            })
        );

        expect(invalid.status).toBe(400);
        expect(valid.status).toBe(200);
    });
});

describe('GET /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('returns only the canonical unified automation policy', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                gameAutomation: {
                    paused: true,
                    rules: {
                        lichess: { rapid: 'AUTO_ANALYZE' },
                        chesscom: { bullet: 'IGNORE' },
                    },
                },
                autoAnalysis: { enabled: true },
            },
        });
        const route = await importRoute();
        const response = await route.GET();
        const body = await readJson<{
            ownerId: string;
            preferences: Record<string, unknown> & {
                gameAutomation: {
                    paused: boolean;
                    rules: Record<string, Record<string, string>>;
                };
            };
        }>(response);

        expect(body.ownerId).toBe('user-1');
        expect(body.preferences.gameAutomation.paused).toBe(true);
        expect(body.preferences.gameAutomation.rules.lichess.rapid).toBe(
            'AUTO_ANALYZE'
        );
        expect(body.preferences).not.toHaveProperty('autoAnalysis');
        expect(body.preferences).not.toHaveProperty('autoSyncEnabled');
    });
});
