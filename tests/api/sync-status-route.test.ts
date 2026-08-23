import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    setMockUserId,
} from '../helpers/route-mocks';

const readSyncStatusSnapshotMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/syncStatusRead', () => ({
        readSyncStatusSnapshot: readSyncStatusSnapshotMock,
    }));
    readSyncStatusSnapshotMock.mockResolvedValue({
        ownerId: 'user-1',
        linked: {
            lichessUsername: 'Ada',
            chesscomUsername: null,
        },
        lastSync: { lichess: null, chesscom: null },
        gameAutomation: {
            paused: false,
            rules: {
                lichess: { rapid: 'IMPORT_ONLY' },
                chesscom: { rapid: 'IMPORT_ONLY' },
            },
            schedule: '0 3 * * *',
            states: { lichess: null, chesscom: null },
        },
        analysisJobs: { queued: 4, running: 1, failed: 2 },
        billing: { reservableCredits: 7 },
        inventory: {
            totalImported: 20,
            analyzed: 8,
            unanalyzed: 12,
        },
        automation: {
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
            dailyGameLimit: 10,
            monthlyGameLimit: 50,
            creditReserve: 10,
            existingGames: 'new',
            enabledAt: '2026-07-20T00:00:00.000Z',
        },
        inventory: { totalImported: 20, analyzed: 8, unanalyzed: 12 },
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
            creditReserve: 10,
            dailyRemaining: 10,
            monthlyRemaining: 50,
            planMonthlyRemaining: 100,
            blockingReason: 'reserve',
        },
        },
    });
    return import('@/app/api/sync/status/route');
}

describe('GET /api/sync/status', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
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
                    creditReserve: 10,
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
        expect(readSyncStatusSnapshotMock).toHaveBeenCalledOnce();
        expect(readSyncStatusSnapshotMock).toHaveBeenCalledWith('user-1');
        expect(response.headers.get('x-backranq-db-operation-count')).toBe('0');
    });
});
