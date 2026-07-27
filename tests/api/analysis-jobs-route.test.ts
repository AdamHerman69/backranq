import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type AnalysisJobsRouteModule = typeof import('@/app/api/analysis/jobs/route');

const publishMock = vi.fn();
const dispatchQueuedAnalysisJobsMock = vi.fn();

async function importRoute(): Promise<AnalysisJobsRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        dispatchQueuedAnalysisJobs: dispatchQueuedAnalysisJobsMock,
    }));
    return import('@/app/api/analysis/jobs/route');
}

function billingAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE',
        serverCreditsBalance: 99,
        monthlyServerCreditsUsed: 0,
        serverCreditsRenewAt: new Date('2026-08-05T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyCap: 50,
        autoAnalysisDailyCap: 10,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        updatedAt: new Date('2026-07-05T00:00:00Z'),
        ...overrides,
    };
}

function primeCreditReservationMocks() {
    prismaMock.analysisRun.create.mockResolvedValue({
        id: 'run-1',
        userId: 'user-1',
        gameId: 'game-1',
        status: 'QUEUED',
        executionMode: 'SERVER_QUEUE',
        queuedReason: 'manual',
        configHash: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        consumedCredits: 0,
        lastError: null,
    });
    prismaMock.billingAccount.upsert.mockResolvedValue(billingAccount());
    prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.creditLedgerEntry.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ type: 'RESERVED', credits: 1 }]);
    prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
        billingAccount({ serverCreditsBalance: 98 })
    );
    prismaMock.creditLedgerEntry.create.mockResolvedValue({
        id: 'entry-1',
        userId: 'user-1',
        type: 'RESERVED',
        credits: 1,
        idempotencyKey: 'analysis-run:run-1:reserve',
    });
}

function post(body: unknown) {
    return createJsonRequest('http://localhost/api/analysis/jobs', body, {
        method: 'POST',
    });
}

describe('GET /api/analysis/jobs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('scopes requested job IDs to the authenticated user', async () => {
        const route = await importRoute();
        prismaMock.analysisJob.findMany.mockResolvedValue([]);
        const firstId = '11111111-1111-4111-8111-111111111111';
        const secondId = '22222222-2222-4222-8222-222222222222';

        const response = await route.GET(
            new Request(
                `http://localhost/api/analysis/jobs?ids=${firstId},${secondId}&limit=100`
            )
        );

        expect(response.status).toBe(200);
        expect(prismaMock.analysisJob.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: 'user-1',
                    id: { in: [firstId, secondId] },
                },
                take: 100,
            })
        );
    });
});

describe('POST /api/analysis/jobs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        publishMock.mockResolvedValue({ queued: true, messageId: 'msg-1' });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: ['job-1'],
            published: [{ jobId: 'job-1', queued: true, messageId: 'msg-1' }],
        });
        primeCreditReservationMocks();
    });

    it('requires auth before enqueueing analysis jobs', async () => {
        setMockUserId(null);
        const route = await importRoute();

        const response = await route.POST(post({ gameIds: ['game-1'] }));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('queues only games owned by the current user', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            estimatedCredits: 1,
            queuedReason: 'manual',
            createdAt: new Date(),
            startedAt: null,
        });

        const response = await route.POST(
            post({ gameIds: ['game-1', 'other-user-game'] })
        );
        const body = await readJson<{ queued: number; skipped: number }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ queued: 1, skipped: 0 });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', id: { in: ['game-1', 'other-user-game'] } },
            select: { id: true },
        });
        expect(prismaMock.analysisJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                gameId: 'game-1',
                queuedReason: 'manual',
            }),
        });
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledWith({
            globalLimit: 25,
            perUserLimit: 1,
        });
    });

    it('marks forced re-analysis for dispatcher scheduling', async () => {
        const route = await importRoute();
        const updatedAt = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'SUCCEEDED',
            priority: 0,
            estimatedCredits: 1,
            weight: 0,
            queuedReason: 'manual',
        });
        prismaMock.analysisJob.update.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            estimatedCredits: 1,
            queuedReason: 'manual-reanalysis',
            createdAt: new Date(),
            startedAt: null,
            updatedAt,
        });

        const response = await route.POST(post({ gameIds: ['game-1'], force: true }));

        expect(response.status).toBe(200);
        expect(prismaMock.analysisJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: 'QUEUED',
                queuedReason: 'manual-reanalysis',
            }),
        });
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledWith({
            globalLimit: 25,
            perUserLimit: 1,
        });
    });
});
