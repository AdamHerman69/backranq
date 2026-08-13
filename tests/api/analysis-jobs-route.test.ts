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
const cancelUnexecutableAnalysisJobsMock = vi.fn();
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GAME_ID = '22222222-2222-4222-8222-222222222222';

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
        cancelUnexecutableAnalysisJobs:
            cancelUnexecutableAnalysisJobsMock,
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
        serverCreditsPeriodStart: new Date('2026-07-05T00:00:00Z'),
        serverCreditsRenewAt: new Date('2027-08-05T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
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
        analysisQuality: 'THOROUGH',
        creditCost: 10,
        queuedReason: 'manual',
        configHash: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        consumedCredits: null,
        lastError: null,
    });
    prismaMock.billingAccount.upsert.mockResolvedValue(billingAccount());
    prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.creditLedgerEntry.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }]);
    prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
        billingAccount({ serverCreditsBalance: 89 })
    );
    prismaMock.creditLedgerEntry.create.mockResolvedValue({
        id: 'entry-1',
        userId: 'user-1',
        type: 'RESERVED',
        credits: 10,
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

    it('tracks a correlated batch larger than 100 jobs', async () => {
        const route = await importRoute();
        prismaMock.analysisJob.findMany.mockResolvedValue([]);
        const ids = Array.from(
            { length: 150 },
            (_, index) =>
                `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
        );

        const response = await route.GET(
            new Request(
                `http://localhost/api/analysis/jobs?ids=${ids.join(',')}`
            )
        );

        expect(response.status).toBe(200);
        expect(prismaMock.analysisJob.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: 'user-1',
                    id: { in: ids },
                }),
                take: 150,
            })
        );
    });

    it.each(['abc', '1.5', '0', '201', 'Infinity'])(
        'rejects invalid limit %s before querying Prisma',
        async (limit) => {
            const route = await importRoute();
            const response = await route.GET(
                new Request(
                    `http://localhost/api/analysis/jobs?limit=${encodeURIComponent(limit)}`
                )
            );

            expect(response.status).toBe(400);
            await expect(readJson(response)).resolves.toEqual({
                error: 'limit must be an integer between 1 and 200',
            });
            expect(prismaMock.analysisJob.findMany).not.toHaveBeenCalled();
        }
    );
});

describe('POST /api/analysis/jobs', () => {
    it('requires the idempotent batch mutation contract', async () => {
        const route = await importRoute();

        const response = await route.POST(post({ gameIds: [GAME_ID] }));

        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET');
        await expect(readJson(response)).resolves.toEqual({
            error: 'Use POST /api/analysis/batches',
            code: 'ANALYSIS_BATCH_REQUIRED',
        });
    });
});

describe.skip('legacy POST /api/analysis/jobs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        publishMock.mockResolvedValue({ queued: true, messageId: 'msg-1' });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: ['job-1'],
            published: [{ jobId: 'job-1', queued: true, messageId: 'msg-1' }],
        });
        cancelUnexecutableAnalysisJobsMock.mockResolvedValue({
            cancelled: 1,
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

    it('rejects an oversized request body before parsing or querying games', async () => {
        const route = await importRoute();
        const response = await route.POST(
            post({ gameIds: ['x'.repeat(40_000)] })
        );

        expect(response.status).toBe(413);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Request exceeds limit of 32768 bytes',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
        expect(dispatchQueuedAnalysisJobsMock).not.toHaveBeenCalled();
    });

    it('rejects invalid game UUIDs before querying Prisma', async () => {
        const route = await importRoute();

        const response = await route.POST(
            post({ gameIds: [GAME_ID, 'not-a-uuid'] })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid gameIds',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
        expect(dispatchQueuedAnalysisJobsMock).not.toHaveBeenCalled();
    });

    it('rejects legacy or unknown quality fields instead of silently repricing', async () => {
        const route = await importRoute();

        const response = await route.POST(
            post({
                gameIds: [GAME_ID],
                analysisQuality: 'STANDARD',
            })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis request',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('requires force to be a boolean', async () => {
        const route = await importRoute();
        const response = await route.POST(
            post({ gameIds: [GAME_ID], force: 'true' })
        );

        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('queues only games owned by the current user', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: GAME_ID }]);
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            pgn: '[Event "Source"]\n\n1. e4 *',
        });
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: GAME_ID,
            status: 'QUEUED',
            queuedReason: 'manual',
            createdAt: new Date(),
            startedAt: null,
        });

        const response = await route.POST(
            post({ gameIds: [GAME_ID, OTHER_GAME_ID] })
        );
        const body = await readJson<{ queued: number; skipped: number }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ queued: 1, skipped: 0 });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', id: { in: [GAME_ID, OTHER_GAME_ID] } },
            select: { id: true },
        });
        expect(prismaMock.analysisJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                gameId: GAME_ID,
                queuedReason: 'manual',
            }),
        });
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledWith({
            globalLimit: 25,
            perUserLimit: 1,
        });
    });

    it('reports queue-disabled execution truthfully and cancels the reservation', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: GAME_ID }]);
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            pgn: '[Event "Source"]\n\n1. e4 *',
        });
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: GAME_ID,
            status: 'QUEUED',
            queuedReason: 'manual',
            createdAt: new Date(),
            startedAt: null,
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: ['job-1'],
            published: [
                {
                    jobId: 'job-1',
                    queued: false,
                    messageId: null,
                    unavailableReason: 'disabled',
                },
            ],
        });

        const response = await route.POST(post({ gameIds: [GAME_ID] }));

        expect(response.status).toBe(503);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'SERVER_ANALYSIS_UNAVAILABLE',
            executionAvailable: false,
            queued: 0,
            cancelled: 1,
        });
        expect(cancelUnexecutableAnalysisJobsMock).toHaveBeenCalledWith({
            userId: 'user-1',
            jobIds: ['job-1'],
            reason: 'Server analysis queue is disabled',
        });
    });

    it('marks forced re-analysis for dispatcher scheduling', async () => {
        const route = await importRoute();
        const updatedAt = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: GAME_ID }]);
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            pgn: '[Event "Source"]\n\n1. e4 *',
        });
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: GAME_ID,
            status: 'SUCCEEDED',
            priority: 0,
            weight: 0,
            queuedReason: 'manual',
        });
        prismaMock.analysisJob.update.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: GAME_ID,
            status: 'QUEUED',
            queuedReason: 'manual-reanalysis',
            createdAt: new Date(),
            startedAt: null,
            updatedAt,
        });

        const response = await route.POST(
            post({ gameIds: [GAME_ID], force: true })
        );

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
