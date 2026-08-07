import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    defaultPreferences,
    mergePreferences,
    resolveAutoAnalysisPolicy,
} from '@/lib/preferences';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const enqueueAnalysisJobMock = vi.fn();
const publishBackranqQueueMessageMock = vi.fn();
const cancelUnexecutableAnalysisJobsMock = vi.fn();
const dispatchQueuedAnalysisJobsMock = vi.fn();

async function importBacklog() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/analysisJobs', () => ({
        AUTO_ANALYSIS_QUEUED_REASONS: ['auto-sync', 'auto-analysis'],
        enqueueAnalysisJob: enqueueAnalysisJobMock,
        serverAnalysisConfigFromPreferences: () => ({
            config: { snapshot: {}, hash: 'config-hash' },
        }),
    }));
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        cancelUnexecutableAnalysisJobs:
            cancelUnexecutableAnalysisJobsMock,
        dispatchQueuedAnalysisJobs: dispatchQueuedAnalysisJobsMock,
    }));
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage:
            publishBackranqQueueMessageMock,
    }));
    return import('@/lib/services/autoAnalysisBacklog');
}

function account(serverCreditsBalance: number) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE' as const,
        planSource: 'FREE' as const,
        stripePlan: 'FREE' as const,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
        stripeLastEventCreatedAt: null,
        stripeLastEventId: null,
        serverCreditsBalance,
        monthlyServerCreditsUsed: 0,
        serverCreditsPeriodStart: new Date('2026-07-01T00:00:00Z'),
        serverCreditsRenewAt: new Date('2027-08-01T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
}

function enabledPreferences(overrides: Record<string, unknown> = {}) {
    return mergePreferences(defaultPreferences(), {
        gameAutomation: {
            rules: {
                lichess: { rapid: 'AUTO_ANALYZE' },
            },
            analysis: {
                existingGames: 'all',
                resultScope: 'all',
                ratedOnly: false,
                minPlies: 0,
                creditReserve: 0,
                ...overrides,
            },
        },
    });
}

function candidate() {
    return {
        id: 'game-1',
        provider: 'LICHESS',
        result: '0-1',
        timeClass: 'RAPID',
        rated: true,
        pgn: '1. e4 e5 0-1',
        whiteName: 'Ada',
        blackName: 'Bob',
        playedAt: new Date('2026-07-20T12:00:00Z'),
        createdAt: new Date('2026-07-20T12:01:00Z'),
    };
}

function primeContext(serverCreditsBalance: number) {
    prismaMock.user.findUnique.mockResolvedValue({
        preferences: enabledPreferences(),
        lichessUsername: 'Ada',
        chesscomUsername: null,
    });
    prismaMock.analyzedGame.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
    prismaMock.analyzedGame.findMany.mockResolvedValue([candidate()]);
    prismaMock.analysisJob.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);
    prismaMock.billingAccount.findUnique.mockResolvedValue(
        account(serverCreditsBalance)
    );
    prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
}

describe('auto-analysis backlog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);
        prismaMock.analysisRun.findMany.mockResolvedValue([]);
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'message-1',
        });
        cancelUnexecutableAnalysisJobsMock.mockResolvedValue({
            cancelled: 1,
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [],
            claimedJobIds: [],
            published: [],
        });
    });

    it('reports truthful inventory, active jobs, and a no-credit backlog', async () => {
        primeContext(0);
        const backlog = await importBacklog();

        const status = await backlog.getAutoAnalysisStatus(
            'user-1',
            new Date('2026-07-21T00:00:00Z')
        );

        expect(status.inventory).toEqual({
            totalImported: 5,
            analyzed: 2,
            unanalyzed: 3,
        });
        expect(status.backlog).toEqual({
            eligible: 1,
            eligibleAtLeast: 1,
            waitingForCredits: 1,
            waitingForCreditsAtLeast: 1,
            blockedReason: 'credits',
            queued: 1,
            running: 2,
            terminalFailed: 3,
            countsExact: true,
            scannedCandidates: 1,
            scanLimit: 250,
        });
    });

    it('does not create a failed job when blocked and queues on a later rerun after top-up', async () => {
        const backlog = await importBacklog();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: enabledPreferences(),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue([candidate()]);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique
            .mockResolvedValueOnce(account(0))
            .mockResolvedValueOnce(account(10));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        enqueueAnalysisJobMock.mockResolvedValue({
            queued: true,
            created: true,
            job: { id: 'job-1' },
        });

        const blocked = await backlog.reconcileAutoAnalysisBacklog('user-1');
        const resumed = await backlog.reconcileAutoAnalysisBacklog('user-1');

        expect(blocked.queued).toBe(0);
        expect(blocked.backlog.blockedReason).toBe('credits');
        expect(resumed.queued).toBe(1);
        expect(enqueueAnalysisJobMock).toHaveBeenCalledTimes(1);
    });

    it('excludes terminal failures and active/succeeded work from reconciliation', async () => {
        primeContext(10);
        const backlog = await importBacklog();

        await backlog.getAutoAnalysisStatus('user-1');

        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    analysisJobs: {
                        none: {
                            status: {
                                in: [
                                    'QUEUED',
                                    'RUNNING',
                                    'SUCCEEDED',
                                    'FAILED',
                                ],
                            },
                        },
                    },
                }),
            })
        );
    });

    it('establishes a safe boundary before reconciling legacy enabled records', async () => {
        const legacy = enabledPreferences({
            existingGames: 'new',
            enabledAt: null,
        });
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: legacy,
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.user.update.mockResolvedValue({ id: 'user-1' });
        prismaMock.analyzedGame.count
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue([candidate()]);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(10));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();
        const now = new Date('2026-07-21T00:00:00Z');

        const result = await backlog.reconcileAutoAnalysisBacklog('user-1', {
            now,
        });

        expect(result.queued).toBe(0);
        expect(prismaMock.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: {
                preferences: expect.objectContaining({
                    gameAutomation: expect.objectContaining({
                        analysis: expect.objectContaining({
                            enabledAt: now.toISOString(),
                        }),
                    }),
                }),
            },
        });
    });

    it('calculates the lower personal/plan budget and reserve floor', async () => {
        const backlog = await importBacklog();
        const policy = resolveAutoAnalysisPolicy(
            enabledPreferences({
                dailyGameLimit: 20,
                monthlyGameLimit: 40,
                creditReserve: 4,
            })
        );

        const capacity = backlog.calculateAutoAnalysisCapacity({
            policy,
            account: {
                ...account(30),
                autoAnalysisDailyGameLimit: 2,
                autoAnalysisMonthlyGameLimit: 3,
            },
            ledger: [],
            now: new Date('2026-07-21T00:00:00Z'),
        });

        expect(capacity).toMatchObject({
            reservableCredits: 26,
            reservableGames: 2,
            dailyRemaining: 2,
            monthlyRemaining: 3,
            creditReserve: 4,
        });
    });

    it('counts automatic capacity in games after applying the quality price', async () => {
        const backlog = await importBacklog();
        const thorough = backlog.calculateAutoAnalysisCapacity({
            policy: resolveAutoAnalysisPolicy(
                enabledPreferences({
                    dailyGameLimit: 3,
                    monthlyGameLimit: 3,
                })
            ),
            account: account(30),
            ledger: [],
            now: new Date('2026-07-21T00:00:00Z'),
        });
        const standardPreferences = enabledPreferences({
            dailyGameLimit: 3,
            monthlyGameLimit: 3,
        });
        standardPreferences.analysisQuality = 'STANDARD';
        const standard = backlog.calculateAutoAnalysisCapacity({
            policy: resolveAutoAnalysisPolicy(standardPreferences),
            account: account(21),
            ledger: [],
            now: new Date('2026-07-21T00:00:00Z'),
        });

        expect(thorough).toMatchObject({
            creditsPerGame: 10,
            reservableCredits: 30,
            reservableGames: 3,
        });
        expect(standard).toMatchObject({
            creditsPerGame: 7,
            reservableCredits: 21,
            reservableGames: 3,
        });
    });

    it('uses the stored billing period start across short month boundaries', async () => {
        const backlog = await importBacklog();
        const capacity = backlog.calculateAutoAnalysisCapacity({
            policy: resolveAutoAnalysisPolicy(
                enabledPreferences({
                    dailyGameLimit: 10,
                    monthlyGameLimit: 2,
                })
            ),
            account: {
                ...account(20),
                serverCreditsPeriodStart: new Date(
                    '2026-02-28T12:00:00Z'
                ),
                serverCreditsRenewAt: new Date(
                    '2026-03-31T12:00:00Z'
                ),
            },
            ledger: [
                {
                    type: 'RESERVED',
                    credits: 10,
                    reason: 'auto-analysis',
                    createdAt: new Date('2026-03-01T00:00:00Z'),
                    analysisRunId: 'run-1',
                    analysisRunCreatedAt: new Date(
                        '2026-02-28T12:30:00Z'
                    ),
                },
            ],
            now: new Date('2026-03-30T12:00:00Z'),
        });

        expect(capacity.monthlyRemaining).toBe(1);
        expect(capacity.reservableGames).toBe(1);
    });

    it('reports partial capacity as a truthful waiting lower bound with a reason', async () => {
        const games = Array.from({ length: 5 }, (_, index) => ({
            ...candidate(),
            id: `game-${index}`,
        }));
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: enabledPreferences(),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue(games);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(20));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();

        const status = await backlog.getAutoAnalysisStatus('user-1');

        expect(status.backlog).toMatchObject({
            eligible: 5,
            eligibleAtLeast: 5,
            waitingForCredits: 3,
            waitingForCreditsAtLeast: 3,
            blockedReason: 'credits',
            countsExact: true,
        });
    });

    it('attributes partial balance capacity to the configured reserve floor', async () => {
        const games = Array.from({ length: 5 }, (_, index) => ({
            ...candidate(),
            id: `game-${index}`,
        }));
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: enabledPreferences({ creditReserve: 4 }),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(5);
        prismaMock.analyzedGame.findMany.mockResolvedValue(games);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(24));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();

        const status = await backlog.getAutoAnalysisStatus('user-1');

        expect(status.backlog).toMatchObject({
            waitingForCredits: 3,
            blockedReason: 'reserve',
        });
    });

    it('skips candidate PGNs entirely while disabled', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: defaultPreferences(),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(0);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(10));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();

        const status = await backlog.getAutoAnalysisStatus('user-1');

        expect(status.backlog).toMatchObject({
            eligible: 0,
            countsExact: true,
            scannedCandidates: 0,
            blockedReason: 'disabled',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('marks a bounded candidate scan as an explicit lower bound', async () => {
        const games = Array.from({ length: 251 }, (_, index) => ({
            ...candidate(),
            id: `game-${index}`,
        }));
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: enabledPreferences(),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(251);
        prismaMock.analyzedGame.findMany.mockResolvedValue(games);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(100));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();

        const status = await backlog.getAutoAnalysisStatus('user-1');

        expect(status.backlog).toMatchObject({
            eligible: 250,
            eligibleAtLeast: 250,
            countsExact: false,
            scannedCandidates: 250,
            scanLimit: 250,
        });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 251 })
        );
    });

    it('publishes a durable cursor and progresses past an ineligible page', async () => {
        const shortGames = Array.from({ length: 2_001 }, (_, index) => ({
            ...candidate(),
            id: `short-${String(index).padStart(4, '0')}`,
            pgn: '1. e4 *',
        }));
        const olderEligible = {
            ...candidate(),
            id: 'older-eligible',
            playedAt: new Date('2026-07-19T12:00:00Z'),
            pgn:
                '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 ' +
                '5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O ' +
                '9. h3 Nb8 10. d4 Nbd7 0-1',
        };
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: enabledPreferences({ minPlies: 20 }),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(2_002);
        prismaMock.analyzedGame.findMany
            .mockResolvedValueOnce(shortGames)
            .mockResolvedValueOnce([olderEligible]);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(10));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        enqueueAnalysisJobMock.mockResolvedValue({
            queued: true,
            created: true,
            job: { id: 'job-older' },
        });
        const backlog = await importBacklog();

        const first =
            await backlog.reconcileAndDispatchAutoAnalysisBacklog('user-1');
        expect(first.reconciliation.queued).toBe(0);
        expect(first.reconciliation.nextCursor).not.toBeNull();
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'reconcile-auto-analysis',
                cursor: first.reconciliation.nextCursor,
            }),
            expect.any(Object)
        );

        const second = await backlog.reconcileAutoAnalysisBacklog('user-1', {
            cursor: first.reconciliation.nextCursor ?? undefined,
        });

        expect(second.queued).toBe(1);
        expect(
            prismaMock.analyzedGame.findMany.mock.calls[1]?.[0]
        ).toEqual(
            expect.objectContaining({
                where: expect.objectContaining({
                    AND: expect.any(Array),
                }),
            })
        );
    });

    it('publishes a durable per-user wakeup without reconciling inline', async () => {
        const backlog = await importBacklog();

        const result = await backlog.requestAutoAnalysisWakeup(
            'user-1',
            'billing'
        );

        expect(result).toMatchObject({ queued: true, inline: false });
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'reconcile-auto-analysis',
                userId: 'user-1',
                reason: 'billing',
            }),
            expect.objectContaining({
                idempotencyKey: expect.stringContaining(
                    'auto-analysis-reconcile:user-1:billing:'
                ),
            })
        );
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    });

    it('publishes one idempotent continuation for a terminal automatic run', async () => {
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            userId: 'user-1',
            status: 'SUCCEEDED',
            analysisRun: {
                id: 'run-1',
                queuedReason: 'auto-analysis',
            },
        });
        const backlog = await importBacklog();

        const result =
            await backlog.requestAutoAnalysisContinuationAfterTerminalJob(
                'job-1'
            );

        expect(result).toMatchObject({
            queued: true,
            messageId: 'message-1',
        });
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'reconcile-auto-analysis',
                userId: 'user-1',
                reason: 'capacity-release',
            }),
            {
                idempotencyKey:
                    'auto-analysis-terminal:run-1:reconcile',
            }
        );
    });

    it('does not continue a terminal manual run', async () => {
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            userId: 'user-1',
            status: 'SUCCEEDED',
            analysisRun: {
                id: 'run-1',
                queuedReason: 'manual',
            },
        });
        const backlog = await importBacklog();

        await expect(
            backlog.requestAutoAnalysisContinuationAfterTerminalJob('job-1')
        ).resolves.toBeNull();
        expect(publishBackranqQueueMessageMock).not.toHaveBeenCalled();
    });

    it('does not reserve inline when the durable queue is unavailable', async () => {
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: false,
            messageId: null,
            unavailableReason: 'disabled',
        });
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: defaultPreferences(),
            lichessUsername: 'Ada',
            chesscomUsername: null,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(0);
        prismaMock.analysisJob.count.mockResolvedValue(0);
        prismaMock.billingAccount.findUnique.mockResolvedValue(account(10));
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        const backlog = await importBacklog();

        const result = await backlog.requestAutoAnalysisWakeup(
            'user-1',
            'capacity-release'
        );

        expect(result).toMatchObject({
            queued: false,
            inline: false,
        });
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
        expect(enqueueAnalysisJobMock).not.toHaveBeenCalled();
    });

    it('cancels and releases the single reservation when worker publication fails', async () => {
        primeContext(10);
        enqueueAnalysisJobMock.mockResolvedValue({
            queued: true,
            created: true,
            job: { id: 'job-1' },
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [{ id: 'job-1' }],
            claimedJobIds: ['job-1'],
            published: [
                {
                    jobId: 'job-1',
                    queued: false,
                    messageId: null,
                    unavailableReason: 'publish-failed',
                },
            ],
        });
        const backlog = await importBacklog();

        const result =
            await backlog.reconcileAndDispatchAutoAnalysisBacklog('user-1');

        expect(result.reconciliation.queued).toBe(1);
        expect(enqueueAnalysisJobMock).toHaveBeenCalledTimes(1);
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledWith(
            expect.objectContaining({ userIds: ['user-1'], globalLimit: 1 })
        );
        expect(cancelUnexecutableAnalysisJobsMock).toHaveBeenCalledWith({
            userId: 'user-1',
            jobIds: ['job-1'],
            reason:
                'Automatic analysis could not be handed to a durable worker',
        });
        expect(result.cleanup).toEqual({ cancelled: 1 });
    });

    it('redispatches an already-reserved queued job after a processor retry', async () => {
        primeContext(10);
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [{ id: 'existing-job', userId: 'user-1' }],
            claimedJobIds: ['existing-job'],
            published: [
                {
                    jobId: 'existing-job',
                    queued: true,
                    messageId: 'worker-message',
                },
            ],
        });
        const backlog = await importBacklog();

        const result =
            await backlog.reconcileAndDispatchAutoAnalysisBacklog('user-1');

        expect(result.reconciliation.queued).toBe(0);
        expect(result.reconciliation.backlog.queued).toBe(1);
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                userIds: ['user-1'],
                globalLimit: 1,
            })
        );
    });

    it('sweeps enabled policies in bounded durable pages', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            { id: 'user-1', preferences: enabledPreferences() },
            { id: 'user-2', preferences: defaultPreferences() },
            { id: 'user-3', preferences: enabledPreferences() },
        ]);
        const backlog = await importBacklog();
        const requestedAt = '2026-07-21T03:00:00.000Z';

        const result = await backlog.dispatchAutoAnalysisPolicySweep({
            requestedAt,
            limit: 2,
        });

        expect(result).toMatchObject({
            scanned: 2,
            enabled: 1,
            nextCursor: 'user-2',
        });
        expect(publishBackranqQueueMessageMock).toHaveBeenNthCalledWith(
            1,
            {
                type: 'reconcile-auto-analysis',
                userId: 'user-1',
                requestedAt,
                reason: 'scheduled',
            },
            expect.objectContaining({
                idempotencyKey:
                    `auto-analysis-reconcile:user-1:scheduled:${requestedAt}`,
            })
        );
        expect(publishBackranqQueueMessageMock).toHaveBeenNthCalledWith(
            2,
            {
                type: 'reconcile-auto-analysis-sweep',
                requestedAt,
                cursor: 'user-2',
            },
            expect.any(Object)
        );
        expect(enqueueAnalysisJobMock).not.toHaveBeenCalled();
    });
});
