import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/services/analysisJobs', () => ({
        getAnalysisJobCounts: vi.fn(async () => ({
            queued: 4,
            running: 1,
            failed: 2,
        })),
    }));
    vi.doMock('@/lib/games/serverAnalysisCapacity', () => ({
        getManualServerAnalysisCapacity: vi.fn(async () => ({
            reservableCredits: 7,
        })),
    }));
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        getAutoAnalysisStatus: vi.fn(async () => ({
            policy: {
                enabled: true,
                paused: false,
                rules: {
                    lichess: { rapid: 'AUTO_ANALYZE' },
                    chesscom: { rapid: 'IGNORE' },
                },
                ratedOnly: true,
                resultScope: 'losses',
                minPlies: 20,
                dailyCap: 10,
                monthlyCap: 50,
                reserveCredits: 10,
                existingGames: 'new',
                enabledAt: '2026-07-20T00:00:00.000Z',
            },
            inventory: {
                totalImported: 20,
                analyzed: 8,
                unanalyzed: 12,
            },
            backlog: {
                eligible: 9,
                eligibleAtLeast: 9,
                waitingForCredits: 9,
                waitingForCreditsAtLeast: 9,
                blockedReason: 'reserve',
                queued: 2,
                running: 1,
                terminalFailed: 0,
                countsExact: true,
                scannedCandidates: 9,
                scanLimit: 250,
            },
            capacity: {
                reservableCredits: 0,
                currentBalance: 10,
                reserveCredits: 10,
                dailyRemaining: 10,
                monthlyRemaining: 50,
                planMonthlyRemaining: 100,
                blockingReason: 'reserve',
            },
        })),
    }));
    return import('@/app/api/sync/status/route');
}

describe('GET /api/sync/status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.analyzedGame.findFirst.mockResolvedValue(null);
        prismaMock.user.findUnique.mockResolvedValue({
            lichessUsername: 'Ada',
            chesscomUsername: null,
            preferences: {},
        });
        prismaMock.providerSyncState.findMany.mockResolvedValue([]);
    });

    it('exposes canonical automation policy and truthful backlog counts', async () => {
        const route = await importRoute();

        const response = await route.GET();
        const body = await readJson<Record<string, unknown>>(response);

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            ownerId: 'user-1',
            gameAutomation: {
                paused: false,
                rules: {
                    lichess: { rapid: 'IMPORT_ONLY' },
                    chesscom: { rapid: 'IMPORT_ONLY' },
                },
            },
            inventory: {
                totalImported: 20,
                analyzed: 8,
                unanalyzed: 12,
            },
            automation: {
                policy: {
                    enabled: true,
                    reserveCredits: 10,
                    existingGames: 'new',
                },
                backlog: {
                    eligible: 9,
                    eligibleAtLeast: 9,
                    waitingForCredits: 9,
                    countsExact: true,
                    blockedReason: 'reserve',
                    queued: 2,
                    running: 1,
                },
                capacity: {
                    reservableCredits: 0,
                    blockingReason: 'reserve',
                },
            },
        });
    });
});
