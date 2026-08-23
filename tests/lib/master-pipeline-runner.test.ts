import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExactPvUnavailableError } from '@/lib/analysis/serverStockfishErrors';
import {
    WeeklyMasterTerminalError,
    isWeeklyMasterTerminalError,
} from '@/lib/master/pipelineErrors';
import { MasterSourceProviderError } from '@/lib/master/sourceErrors';

const testConfig = vi.hoisted(() => ({
    version: 2 as const,
    scope: 'ANALYSIS' as const,
    targetSourceGameId: null,
    source: {
        providers: ['lichess', 'chesscom'] as const,
        lookbackDays: 21,
        maxGamesPerAccount: 12,
        maxAccountsPerRun: 14,
    },
    analysis: {
        maxSnapshotsPerRun: 1,
        snapshot: { quality: 'test' },
        configHash: 'analysis-config',
        options: { test: true },
    },
    publication: {
        minimumScore: 62,
        freshForDays: 10,
        maxStaleDays: 35,
    },
}));

type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

type RunState = {
    id: string;
    runKey: string;
    status: RunStatus;
    stage: 'SOURCE' | 'ANALYSIS' | 'RANKING' | 'PUBLICATION' | 'COMPLETE';
    attempts: number;
    scheduledFor: Date;
    lockedUntil: Date | null;
    leaseToken: string | null;
    configSnapshot: typeof testConfig;
    configHash: string;
    fetchedGames: number;
    createdSnapshots: number;
    analyzedSnapshots: number;
    eligibleCandidates: number;
    publishedCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    lastError: string | null;
};

const mocks = vi.hoisted(() => ({
    run: null as RunState | null,
    loseCompletionLease: false,
    loseBoundedFailureLease: false,
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findDiscoveries: vi.fn(),
    findAccount: vi.fn(),
    findReceipts: vi.fn(),
    findReceipt: vi.fn(),
    countCandidates: vi.fn(),
    upsertReceipt: vi.fn(),
    transaction: vi.fn(),
    ensureRoster: vi.fn(),
    orderAccounts: vi.fn(),
    fetchAccount: vi.fn(),
    analyzeSnapshot: vi.fn(),
    publishCandidate: vi.fn(),
    markStale: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        masterPipelineRun: {
            updateMany: mocks.updateMany,
            findUnique: mocks.findUnique,
            findUniqueOrThrow: mocks.findUniqueOrThrow,
        },
        masterSourceGameDiscovery: {
            findMany: mocks.findDiscoveries,
        },
        masterAccount: { findUnique: mocks.findAccount },
        masterAnalysisReceipt: {
            findMany: mocks.findReceipts,
            findUnique: mocks.findReceipt,
        },
        masterCandidate: { count: mocks.countCandidates },
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/master/config', () => ({
    WEEKLY_MASTER_LEASE_MS: 300_000,
    WEEKLY_MASTER_MAX_ATTEMPTS: 3,
    weeklyMasterConfig: () => testConfig,
}));
vi.mock('@/lib/master/ranking', () => ({
    masterContentHash: () => 'config-hash',
}));
vi.mock('@/lib/master/roster', () => ({
    ensureDefaultMasterRoster: mocks.ensureRoster,
    orderMasterAccountsForAnalysis: mocks.orderAccounts,
}));
vi.mock('@/lib/master/source', () => ({
    fetchAndPersistMasterAccount: mocks.fetchAccount,
}));
vi.mock('@/lib/master/analysis', () => ({
    analyzeMasterSnapshot: mocks.analyzeSnapshot,
}));
vi.mock('@/lib/master/publication', () => ({
    publishBestMasterCandidate: mocks.publishCandidate,
    markStaleMasterPublications: mocks.markStale,
}));

import { processWeeklyMasterRun } from '@/lib/master/pipelineRunner';

const NOW = new Date('2026-08-23T06:00:00.000Z');
const ACCOUNT = {
    id: 'account-a',
    username: 'master-a',
    active: true,
    priority: 100,
    person: { id: 'person-a', active: true },
};

type UpdateRequest = {
    where: {
        id: string;
        status?: RunStatus | { in: RunStatus[] };
        attempts?: { lt: number };
        leaseToken?: string;
        scheduledFor?: { lte: Date };
        OR?: Array<
            | { lockedUntil: null }
            | { lockedUntil: { lte: Date } }
            | { status: RunStatus; attempts?: { lt: number } }
        >;
    };
    data: Omit<Partial<RunState>, 'attempts'> & {
        attempts?:
            | number
            | { increment?: number; decrement?: number; set?: number };
    };
};

function freshRun(overrides: Partial<RunState> = {}): RunState {
    return {
        id: 'run-1',
        runKey: 'weekly-master:2026-08-23',
        status: 'QUEUED',
        stage: 'SOURCE',
        attempts: 0,
        scheduledFor: NOW,
        lockedUntil: null,
        leaseToken: null,
        configSnapshot: testConfig,
        configHash: 'config-hash',
        fetchedGames: 0,
        createdSnapshots: 0,
        analyzedSnapshots: 0,
        eligibleCandidates: 0,
        publishedCount: 0,
        startedAt: null,
        completedAt: null,
        lastError: null,
        ...overrides,
    };
}

function matches(request: UpdateRequest) {
    const run = mocks.run;
    if (!run || request.where.id !== run.id) return false;
    const status = request.where.status;
    if (
        typeof status === 'string'
            ? run.status !== status
            : status && !status.in.includes(run.status)
    ) {
        return false;
    }
    if (
        request.where.attempts?.lt != null &&
        run.attempts >= request.where.attempts.lt
    ) {
        return false;
    }
    if (
        request.where.leaseToken != null &&
        run.leaseToken !== request.where.leaseToken
    ) {
        return false;
    }
    if (
        request.where.scheduledFor?.lte &&
        run.scheduledFor > request.where.scheduledFor.lte
    ) {
        return false;
    }
    if (request.where.OR) {
        const matchesAlternative = request.where.OR.some((condition) => {
            if ('status' in condition) {
                return (
                    run.status === condition.status &&
                    (condition.attempts?.lt == null ||
                        run.attempts < condition.attempts.lt)
                );
            }
            if (condition.lockedUntil === null) {
                return run.lockedUntil === null;
            }
            return run.lockedUntil != null &&
                run.lockedUntil <= condition.lockedUntil.lte;
        });
        if (!matchesAlternative) return false;
    }
    return true;
}

function applyUpdate(data: UpdateRequest['data']) {
    const run = mocks.run;
    if (!run) return;
    const attempts = data.attempts;
    if (typeof attempts === 'number') {
        run.attempts = attempts;
    } else if (attempts) {
        run.attempts += attempts.increment ?? 0;
        run.attempts -= attempts.decrement ?? 0;
        if (attempts.set != null) run.attempts = attempts.set;
    }
    for (const [key, value] of Object.entries(data)) {
        if (key === 'attempts') continue;
        Object.assign(run, { [key]: value });
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.run = freshRun();
    mocks.loseCompletionLease = false;
    mocks.loseBoundedFailureLease = false;
    mocks.updateMany.mockImplementation(async (value: unknown) => {
        const request = value as UpdateRequest;
        if (
            mocks.loseCompletionLease &&
            request.data.status === 'SUCCEEDED' &&
            mocks.run
        ) {
            mocks.run.leaseToken = 'new-owner';
        }
        if (
            mocks.loseBoundedFailureLease &&
            typeof request.data.attempts === 'object' &&
            request.data.attempts.increment === 1 &&
            mocks.run
        ) {
            mocks.run.leaseToken = 'new-owner';
        }
        if (!matches(request)) return { count: 0 };
        applyUpdate(request.data);
        return { count: 1 };
    });
    mocks.findUnique.mockImplementation(async () =>
        mocks.run ? { ...mocks.run } : null
    );
    mocks.findUniqueOrThrow.mockImplementation(async () => {
        if (!mocks.run) throw new Error('not found');
        return { ...mocks.run };
    });
    const receipts = new Map<
        string,
        { complete: boolean; pipelineRunId: string }
    >();
    mocks.findReceipt.mockImplementation(async (value: unknown) => {
        const request = value as {
            where: {
                snapshotId_accountId_configHash: {
                    snapshotId: string;
                    accountId: string;
                    configHash: string;
                };
            };
        };
        const key = Object.values(
            request.where.snapshotId_accountId_configHash
        ).join(':');
        return receipts.get(key) ?? null;
    });
    mocks.upsertReceipt.mockImplementation(async (value: unknown) => {
        const request = value as {
            where: {
                snapshotId_accountId_configHash: {
                    snapshotId: string;
                    accountId: string;
                    configHash: string;
                };
            };
            create: { pipelineRunId: string; complete: boolean };
            update: { pipelineRunId: string; complete: boolean };
        };
        const key = Object.values(
            request.where.snapshotId_accountId_configHash
        ).join(':');
        const receipt = receipts.has(key) ? request.update : request.create;
        receipts.set(key, {
            complete: receipt.complete,
            pipelineRunId: receipt.pipelineRunId,
        });
        return receipt;
    });
    mocks.transaction.mockImplementation(
        async (operation: unknown) =>
            (operation as (tx: unknown) => Promise<unknown>)({
                masterPipelineRun: { updateMany: mocks.updateMany },
                masterAnalysisReceipt: { upsert: mocks.upsertReceipt },
            })
    );
    mocks.findDiscoveries.mockResolvedValue([
        {
            accountId: ACCOUNT.id,
            sourceGame: { currentSnapshotId: 'snapshot-a' },
        },
        {
            accountId: ACCOUNT.id,
            sourceGame: { currentSnapshotId: 'snapshot-b' },
        },
        {
            accountId: ACCOUNT.id,
            sourceGame: { currentSnapshotId: 'snapshot-c' },
        },
    ]);
    mocks.findAccount.mockResolvedValue({ personId: ACCOUNT.person.id });
    mocks.findReceipts.mockResolvedValue([]);
    mocks.countCandidates.mockResolvedValue(0);
    mocks.ensureRoster.mockResolvedValue([ACCOUNT]);
    mocks.orderAccounts.mockReturnValue([ACCOUNT]);
    mocks.fetchAccount.mockResolvedValue({ fetched: 0, snapshots: [] });
    mocks.analyzeSnapshot.mockResolvedValue({ candidates: [] });
    mocks.publishCandidate.mockResolvedValue(null);
    mocks.markStale.mockResolvedValue(undefined);
});

describe('Weekly Master durable pipeline runner', () => {
    it('acknowledges a duplicate delivery after success without rerunning work', async () => {
        mocks.run = freshRun({ status: 'SUCCEEDED', attempts: 1 });

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 1 }
        );

        expect(mocks.analyzeSnapshot).not.toHaveBeenCalled();
    });

    it('makes an exhausted failed delivery explicitly terminal', async () => {
        mocks.run = freshRun({ status: 'FAILED', attempts: 3 });

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(WeeklyMasterTerminalError);
        expect(isWeeklyMasterTerminalError(error)).toBe(true);
        expect(mocks.analyzeSnapshot).not.toHaveBeenCalled();
    });

    it('recovers an exact-PV failure on the next snapshot and bounded attempt', async () => {
        mocks.findReceipt
            .mockResolvedValueOnce({
                complete: true,
                pipelineRunId: 'older-run',
            })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                complete: true,
                pipelineRunId: 'older-run',
            });
        mocks.analyzeSnapshot
            .mockRejectedValueOnce(new ExactPvUnavailableError())
            .mockResolvedValueOnce({ candidates: [] });

        await expect(processWeeklyMasterRun('run-1', NOW)).rejects.toThrow(
            'All Weekly Master analyses failed: Engine returned no exact PV'
        );
        expect(mocks.run).toMatchObject({ status: 'QUEUED', attempts: 1 });
        expect(mocks.upsertReceipt).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    snapshotId: 'snapshot-b',
                    pipelineRunId: 'run-1',
                    complete: false,
                    manifest: expect.objectContaining({
                        failure: expect.objectContaining({
                            kind: 'EXACT_PV_UNAVAILABLE',
                        }),
                    }),
                }),
            })
        );
        expect(mocks.analyzeSnapshot).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ snapshotId: 'snapshot-b' })
        );

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 1 }
        );
        expect(mocks.analyzeSnapshot).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ snapshotId: 'snapshot-c' })
        );
    });

    it('resumes a FULL run from durable analysis inputs without refetching every account', async () => {
        if (!mocks.run) throw new Error('missing test run');
        mocks.run.configSnapshot = {
            ...testConfig,
            scope: 'FULL',
        } as unknown as typeof testConfig;
        mocks.fetchAccount.mockResolvedValue({
            fetched: 1,
            snapshots: [
                {
                    created: true,
                    snapshot: { id: 'snapshot-a' },
                },
            ],
        });
        mocks.analyzeSnapshot
            .mockRejectedValueOnce(new ExactPvUnavailableError())
            .mockResolvedValueOnce({ candidates: [] });

        await expect(processWeeklyMasterRun('run-1', NOW)).rejects.toThrow(
            'Engine returned no exact PV'
        );
        expect(mocks.run).toMatchObject({
            status: 'QUEUED',
            stage: 'ANALYSIS',
            attempts: 1,
        });
        expect(mocks.fetchAccount).toHaveBeenCalledOnce();

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 1 }
        );
        expect(mocks.fetchAccount).toHaveBeenCalledOnce();
        expect(mocks.findDiscoveries).toHaveBeenCalledOnce();
        expect(mocks.analyzeSnapshot).toHaveBeenLastCalledWith(
            expect.objectContaining({ snapshotId: 'snapshot-b' })
        );
    });

    it('retries publication from RANKING without running another analysis', async () => {
        mocks.analyzeSnapshot.mockResolvedValue({
            candidates: [{ hardGatePassed: true }],
        });
        mocks.publishCandidate
            .mockRejectedValueOnce(new Error('publication database unavailable'))
            .mockResolvedValueOnce(null);

        await expect(processWeeklyMasterRun('run-1', NOW)).rejects.toThrow(
            'publication database unavailable'
        );
        expect(mocks.run).toMatchObject({
            status: 'QUEUED',
            stage: 'RANKING',
            analyzedSnapshots: 1,
            eligibleCandidates: 1,
            attempts: 0,
        });
        expect(mocks.analyzeSnapshot).toHaveBeenCalledOnce();

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            {
                status: 'SUCCEEDED',
                analyzedSnapshots: 1,
                eligibleCandidates: 1,
            }
        );
        expect(mocks.analyzeSnapshot).toHaveBeenCalledOnce();
        expect(mocks.findDiscoveries).toHaveBeenCalledOnce();
    });

    it('resumes a completed same-run receipt outside the fresh discovery window', async () => {
        if (!mocks.run) throw new Error('missing test run');
        mocks.run.stage = 'ANALYSIS';
        mocks.findReceipts.mockResolvedValueOnce([
            { snapshotId: 'snapshot-old', accountId: ACCOUNT.id },
        ]);
        mocks.findDiscoveries.mockResolvedValueOnce([
            {
                accountId: ACCOUNT.id,
                sourceGame: { currentSnapshotId: 'snapshot-a' },
            },
            {
                accountId: ACCOUNT.id,
                sourceGame: { currentSnapshotId: 'snapshot-b' },
            },
            {
                accountId: ACCOUNT.id,
                sourceGame: { currentSnapshotId: 'snapshot-c' },
            },
            {
                accountId: ACCOUNT.id,
                sourceGame: { currentSnapshotId: 'snapshot-d' },
            },
        ]);
        mocks.countCandidates.mockResolvedValueOnce(2);

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            {
                status: 'SUCCEEDED',
                analyzedSnapshots: 1,
                eligibleCandidates: 2,
            }
        );
        expect(mocks.analyzeSnapshot).not.toHaveBeenCalled();
        expect(mocks.countCandidates).toHaveBeenCalledWith({
            where: {
                pipelineRunId: 'run-1',
                snapshotId: 'snapshot-old',
                accountId: 'account-a',
                hardGatePassed: true,
            },
        });
    });

    it('requeues an unknown FULL-source infrastructure failure', async () => {
        if (!mocks.run) throw new Error('missing test run');
        mocks.run.configSnapshot = {
            ...testConfig,
            scope: 'FULL',
        } as unknown as typeof testConfig;
        mocks.fetchAccount.mockRejectedValue(
            new Error('database connection unavailable')
        );

        await expect(processWeeklyMasterRun('run-1', NOW)).rejects.toThrow(
            'database connection unavailable'
        );
        expect(mocks.run).toMatchObject({
            status: 'QUEUED',
            stage: 'SOURCE',
            attempts: 0,
        });
        expect(mocks.analyzeSnapshot).not.toHaveBeenCalled();
    });

    it('tolerates an explicitly typed provider outage for one FULL-source account', async () => {
        if (!mocks.run) throw new Error('missing test run');
        mocks.run.configSnapshot = {
            ...testConfig,
            scope: 'FULL',
        } as unknown as typeof testConfig;
        mocks.fetchAccount.mockRejectedValue(
            new MasterSourceProviderError('provider unavailable')
        );

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 0 }
        );
        expect(mocks.run).toMatchObject({ stage: 'COMPLETE' });
    });

    it('terminates exactly when the third bounded analysis attempt fails', async () => {
        mocks.run = freshRun({ status: 'FAILED', attempts: 2 });
        mocks.analyzeSnapshot.mockRejectedValue(
            new ExactPvUnavailableError()
        );

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(WeeklyMasterTerminalError);
        expect(mocks.run).toMatchObject({ status: 'FAILED', attempts: 3 });
    });

    it('requeues an unknown infrastructure failure without consuming the bounded budget', async () => {
        mocks.analyzeSnapshot.mockRejectedValue(
            new Error('database connection unavailable')
        );

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toEqual(new Error('database connection unavailable'));
        expect(isWeeklyMasterTerminalError(error)).toBe(false);
        expect(mocks.run).toMatchObject({
            status: 'QUEUED',
            attempts: 0,
            lastError: 'database connection unavailable',
        });
    });

    it('reclaims an expired running lease without incrementing the interrupted attempt', async () => {
        mocks.run = freshRun({
            status: 'RUNNING',
            attempts: 2,
            leaseToken: 'dead-worker',
            lockedUntil: new Date(NOW.getTime() - 1),
        });

        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 2 }
        );
    });

    it('keeps a concurrent duplicate delivery retryable while its lease is live', async () => {
        mocks.run = freshRun({
            status: 'RUNNING',
            attempts: 1,
            leaseToken: 'current-worker',
            lockedUntil: new Date(NOW.getTime() + 60_000),
        });

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toEqual(
            expect.objectContaining({
                message: 'Weekly Master run is not claimable',
            })
        );
        expect(isWeeklyMasterTerminalError(error)).toBe(false);
        expect(mocks.analyzeSnapshot).not.toHaveBeenCalled();
    });

    it('keeps a transient stale reclaim retryable even at the old attempt cap', async () => {
        mocks.run = freshRun({
            status: 'RUNNING',
            attempts: 3,
            leaseToken: 'dead-worker',
            lockedUntil: new Date(NOW.getTime() - 1),
        });
        mocks.analyzeSnapshot.mockRejectedValueOnce(
            new Error('database connection unavailable')
        );

        await expect(processWeeklyMasterRun('run-1', NOW)).rejects.toThrow(
            'database connection unavailable'
        );
        expect(mocks.run).toMatchObject({ status: 'QUEUED', attempts: 3 });

        mocks.analyzeSnapshot.mockResolvedValueOnce({ candidates: [] });
        await expect(processWeeklyMasterRun('run-1', NOW)).resolves.toMatchObject(
            { status: 'SUCCEEDED', attempts: 3 }
        );
    });

    it('clamps a bounded stale legacy reclaim to the exact attempt cap', async () => {
        mocks.run = freshRun({
            status: 'RUNNING',
            attempts: 3,
            leaseToken: 'dead-worker',
            lockedUntil: new Date(NOW.getTime() - 1),
        });
        mocks.analyzeSnapshot.mockRejectedValue(
            new ExactPvUnavailableError()
        );

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(WeeklyMasterTerminalError);
        expect(mocks.run).toMatchObject({ status: 'FAILED', attempts: 3 });
    });

    it('keeps a lost completion fence retryable because terminal state was not proven', async () => {
        mocks.loseCompletionLease = true;

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toEqual(
            expect.objectContaining({
                message: 'Weekly Master failure lost its lease',
            })
        );
        expect(isWeeklyMasterTerminalError(error)).toBe(false);
        expect(mocks.run).toMatchObject({
            status: 'RUNNING',
            leaseToken: 'new-owner',
        });
    });

    it('does not persist a bounded failure receipt after losing its lease fence', async () => {
        mocks.loseBoundedFailureLease = true;
        mocks.analyzeSnapshot.mockRejectedValue(
            new ExactPvUnavailableError()
        );

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toEqual(
            expect.objectContaining({
                message: 'Weekly Master failure lost its lease',
            })
        );
        expect(isWeeklyMasterTerminalError(error)).toBe(false);
        expect(mocks.upsertReceipt).not.toHaveBeenCalled();
    });

    it('persists an invalid configuration as a permanent terminal failure', async () => {
        if (!mocks.run) throw new Error('missing test run');
        mocks.run.configHash = 'invalid-config-hash';

        const error = await processWeeklyMasterRun('run-1', NOW).catch(
            (caught: unknown) => caught
        );

        expect(error).toBeInstanceOf(WeeklyMasterTerminalError);
        expect(mocks.run).toMatchObject({
            status: 'FAILED',
            attempts: 3,
            lastError: 'Weekly Master run configuration is invalid',
        });
    });
});
