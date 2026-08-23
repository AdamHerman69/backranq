import { beforeEach, describe, expect, it, vi } from 'vitest';

const { practiceSummaryMock, syncStatusSnapshotMock } = vi.hoisted(() => ({
    practiceSummaryMock: vi.fn(),
    syncStatusSnapshotMock: vi.fn(),
}));

vi.mock('@/lib/training/practiceDue', () => ({
    getPracticeInventorySummary: practiceSummaryMock,
}));
vi.mock('@/lib/services/syncStatusRead', () => ({
    readSyncStatusSnapshot: syncStatusSnapshotMock,
}));

import { readHomeDashboardSnapshot } from '@/lib/home/readService';

function syncStatusSnapshot() {
    return {
        ownerId: 'owner-1',
        linked: {
            lichessUsername: 'Ada',
            chesscomUsername: null,
        },
        lastSync: {
            lichess: '2026-08-22T10:00:00.000Z',
            chesscom: null,
        },
        gameAutomation: {
            paused: false,
            rules: {},
            schedule: '0 3 * * *',
            states: { lichess: null, chesscom: null },
        },
        analysisJobs: { queued: 2, running: 1, failed: 0 },
        inventory: {
            totalImported: 12,
            analyzed: 8,
            unanalyzed: 4,
        },
        automation: {
            policy: { enabled: true },
            inventory: {
                totalImported: 12,
                analyzed: 8,
                unanalyzed: 4,
            },
            backlog: {
                eligible: 4,
                eligibleAtLeast: 4,
                waitingForCredits: 0,
                waitingForCreditsAtLeast: 0,
                blockedReason: null,
                queued: 2,
                running: 1,
                terminalFailed: 0,
                countsExact: true,
                scannedCandidates: 4,
                scanLimit: 250,
            },
            capacity: { reservableGames: 10, blockingReason: null },
        },
    };
}

describe('Home dashboard server snapshot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        practiceSummaryMock.mockResolvedValue({
            userId: 'owner-1',
            availableCount: 6,
            availableCountIsExact: false,
            dueCount: 2,
            dueCountIsExact: true,
            newCount: 4,
            newCountIsExact: false,
            earliestDueAt: new Date('2026-08-23T09:00:00Z'),
        });
        syncStatusSnapshotMock.mockResolvedValue(syncStatusSnapshot());
    });

    it('composes one JSON-safe first-render snapshot from parallel Practice and status reads', async () => {
        const now = new Date('2026-08-23T12:00:00Z');

        const snapshot = await readHomeDashboardSnapshot('owner-1', { now });

        expect(practiceSummaryMock).toHaveBeenCalledWith('owner-1', now);
        expect(syncStatusSnapshotMock).toHaveBeenCalledWith('owner-1', {
            now,
        });
        expect(snapshot).toMatchObject({
            ownerId: 'owner-1',
            generatedAt: now.toISOString(),
            status: 'ready',
            trainingMomentCount: 6,
            trainingMomentCountIsExact: false,
            duePracticeCount: 2,
            duePracticeCountIsExact: true,
            earliestDueAt: '2026-08-23T09:00:00.000Z',
            gameCount: 12,
            unanalyzedGameCount: 4,
            error: null,
            syncStatus: {
                ownerId: 'owner-1',
                inventory: {
                    totalImported: 12,
                    analyzed: 8,
                    unanalyzed: 4,
                },
            },
        });
        expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
        expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('returns an error snapshot without a client waterfall when the shared status read fails', async () => {
        syncStatusSnapshotMock.mockRejectedValue(
            new Error('status unavailable')
        );

        const snapshot = await readHomeDashboardSnapshot('owner-1', {
            now: new Date('2026-08-23T12:00:00Z'),
        });

        expect(snapshot.status).toBe('error');
        expect(snapshot.trainingMomentCount).toBe(6);
        expect(snapshot.gameCount).toBe(0);
        expect(snapshot.syncStatus).toBeNull();
        expect(snapshot.error).toBe(
            'Could not load your practice overview.'
        );
    });

    it('preserves status inventory in the error snapshot when Practice fails', async () => {
        practiceSummaryMock.mockRejectedValue(
            new Error('practice unavailable')
        );

        const snapshot = await readHomeDashboardSnapshot('owner-1', {
            now: new Date('2026-08-23T12:00:00Z'),
        });

        expect(snapshot.status).toBe('error');
        expect(snapshot.gameCount).toBe(12);
        expect(snapshot.unanalyzedGameCount).toBe(4);
        expect(snapshot.syncStatus?.ownerId).toBe('owner-1');
    });
});
