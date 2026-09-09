import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const enqueueAnalysisJobMock = vi.fn();

async function importService() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/analysisJobs', async () => {
        const actual = await vi.importActual<
            typeof import('@/lib/services/analysisJobs')
        >('@/lib/services/analysisJobs');
        return { ...actual, enqueueAnalysisJob: enqueueAnalysisJobMock };
    });
    return import('@/lib/services/analysisBatches');
}

describe('durable analysis batch planning', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );
    });

    it('atomically persists the batch, unique items, and initial plan outbox', async () => {
        const service = await importService();
        prismaMock.analysisBatch.findUnique.mockResolvedValue(null);
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.analysisBatch.create.mockImplementation(
            async (args: unknown) => ({
                id: 'batch-1',
                ...(args as { data: Record<string, unknown> }).data,
            })
        );
        prismaMock.analysisBatchItem.createMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisOutbox.create.mockResolvedValue({ id: 'outbox-1' });

        const result = await service.createAnalysisBatch({
            userId: 'user-1',
            requestId: '11111111-1111-4111-8111-111111111111',
            gameIds: ['game-1'],
            force: false,
        });

        expect(result.created).toBe(true);
        expect(prismaMock.analysisBatchItem.createMany).toHaveBeenCalledWith({
            data: [
                {
                    batchId: 'batch-1',
                    userId: 'user-1',
                    gameId: 'game-1',
                },
            ],
        });
        expect(prismaMock.analysisOutbox.create).toHaveBeenCalledWith({
            data: {
                batchId: 'batch-1',
                kind: 'ANALYSIS_BATCH_PLAN',
                idempotencyKey: 'analysis-batch:batch-1:plan:initial',
                payload: { type: 'analysis-batch', batchId: 'batch-1' },
            },
        });
    });

    it('replays the same canonical request and rejects changed payloads', async () => {
        const service = await importService();
        prismaMock.analysisBatch.findUnique.mockResolvedValue(null);
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.analysisBatch.create.mockImplementation(
            async (args: unknown) => ({
                id: 'batch-1',
                ...(args as { data: Record<string, unknown> }).data,
            })
        );
        prismaMock.analysisBatchItem.createMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisOutbox.create.mockResolvedValue({ id: 'outbox-1' });
        const args = {
            userId: 'user-1',
            requestId: '11111111-1111-4111-8111-111111111111',
            gameIds: ['game-1'],
            force: false,
        };
        const first = await service.createAnalysisBatch(args);
        const persisted = first.batch;
        prismaMock.analysisBatch.findUnique.mockResolvedValue(persisted);

        await expect(service.createAnalysisBatch(args)).resolves.toMatchObject({
            batch: persisted,
            created: false,
        });
        await expect(
            service.createAnalysisBatch({ ...args, force: true })
        ).rejects.toBeInstanceOf(service.AnalysisBatchRequestConflictError);
    });

    it('records partial planning without marking the batch complete while a job is active', async () => {
        const service = await importService();
        const { InsufficientServerCreditsError } = await import(
            '@/lib/services/billingAccounts'
        );
        const first = {
            id: 'item-1',
            batchId: 'batch-1',
            userId: 'user-1',
            gameId: 'game-1',
        };
        const second = {
            id: 'item-2',
            batchId: 'batch-1',
            userId: 'user-1',
            gameId: 'game-2',
        };
        prismaMock.analysisBatchItem.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisBatchItem.findMany
            .mockResolvedValueOnce([{ id: first.id }, { id: second.id }])
            .mockResolvedValueOnce([first, second])
            .mockResolvedValueOnce([
                { analysisRun: { status: 'QUEUED' } },
            ]);
        prismaMock.analysisBatch.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisBatch.findUnique.mockResolvedValue({
            id: 'batch-1',
            userId: 'user-1',
            requestId: 'request-1',
            queuedReason: 'manual',
            force: false,
            configSnapshot: {},
            configHash: 'hash',
            analysisQuality: 'THOROUGH',
            creditCost: 10,
        });
        enqueueAnalysisJobMock
            .mockResolvedValueOnce({
                queued: true,
                job: {
                    id: 'job-1',
                    analysisRunId: 'run-1',
                    status: 'QUEUED',
                },
            })
            .mockRejectedValueOnce(new InsufficientServerCreditsError());
        prismaMock.analysisBatchItem.groupBy.mockResolvedValue([
            { status: 'QUEUED', _count: { _all: 1 } },
            { status: 'FAILED', _count: { _all: 1 } },
        ]);
        prismaMock.analysisBatch.update.mockResolvedValue({});

        const result = await service.processAnalysisBatchPage('batch-1', 2);

        expect(result).toMatchObject({
            batchId: 'batch-1',
            claimed: 2,
            queued: 1,
            failed: 1,
            remaining: 0,
            continuationOutboxId: null,
        });
        expect(prismaMock.analysisBatch.update).toHaveBeenCalledWith({
            where: { id: 'batch-1' },
            data: expect.objectContaining({
                status: 'QUEUED',
                completedAt: null,
                queuedItems: 1,
                failedItems: 1,
            }),
        });
    });

    it('releases the planning lease and retries infrastructure failures', async () => {
        const service = await importService();
        const item = {
            id: 'item-1',
            batchId: 'batch-1',
            userId: 'user-1',
            gameId: 'game-1',
        };
        prismaMock.analysisBatch.findUnique.mockResolvedValue({
            id: 'batch-1',
            userId: 'user-1',
            requestId: 'request-1',
            status: 'PENDING',
            queuedReason: 'manual',
            force: false,
            configSnapshot: {},
            configHash: 'hash',
            analysisQuality: 'THOROUGH',
            creditCost: 10,
        });
        prismaMock.analysisBatchItem.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisBatchItem.findMany
            .mockResolvedValueOnce([{ id: item.id }])
            .mockResolvedValueOnce([item]);
        prismaMock.analysisBatch.updateMany.mockResolvedValue({ count: 1 });
        enqueueAnalysisJobMock.mockRejectedValueOnce(
            new Error('database temporarily unavailable')
        );

        await expect(
            service.processAnalysisBatchPage('batch-1', 1)
        ).rejects.toThrow('database temporarily unavailable');

        expect(prismaMock.analysisBatchItem.updateMany).toHaveBeenLastCalledWith(
            {
                where: {
                    batchId: 'batch-1',
                    status: 'PLANNING',
                    planningToken: expect.any(String),
                },
                data: {
                    status: 'PENDING',
                    planningToken: null,
                    planningUntil: null,
                },
            }
        );
    });

    it('keeps a completed batch immutable on plan redelivery', async () => {
        const service = await importService();
        prismaMock.analysisBatch.findUnique.mockResolvedValue({
            id: 'batch-1',
            status: 'COMPLETED',
        });

        await expect(
            service.processAnalysisBatchPage('batch-1')
        ).resolves.toMatchObject({
            claimed: 0,
            remaining: 0,
            continuationOutboxId: null,
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.analysisBatch.update).not.toHaveBeenCalled();
    });

    it('does not count a skipped historical run as newly succeeded', async () => {
        const service = await importService();
        prismaMock.analysisBatchItem.groupBy.mockResolvedValue([
            { status: 'SKIPPED', _count: { _all: 1 }, _max: { updatedAt: new Date('2026-08-12T00:00:00.000Z') } },
        ]);
        prismaMock.analysisRun.groupBy.mockResolvedValue([]);

        const summary = await service.analysisBatchSummary({
            id: 'batch-1',
            requestId: 'request-1',
            status: 'COMPLETED',
            force: false,
            analysisQuality: 'THOROUGH',
            creditCost: 10,
            configHash: 'hash',
            totalItems: 1,
            completedAt: new Date('2026-08-12T00:00:00.000Z'),
            lastError: null,
            createdAt: new Date('2026-08-12T00:00:00.000Z'),
            updatedAt: new Date('2026-08-12T00:00:00.000Z'),
        } as never);

        expect(summary.counts).toMatchObject({ skipped: 1, succeeded: 0 });
        expect(prismaMock.analysisRun.groupBy).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    batchItems: {
                        some: {
                            batchId: 'batch-1',
                            status: { in: ['QUEUED', 'ATTACHED'] },
                        },
                    },
                },
            })
        );
    });

    it('returns completed status and the last run completion while the stored batch is still queued', async () => {
        const service = await importService();
        const completedAt = new Date('2026-09-09T08:00:30Z');
        const batchId = '11111111-1111-4111-8111-111111111111';
        const batch = { id: batchId, userId: 'user-1', status: 'QUEUED', totalItems: 3,
            completedAt: null, createdAt: new Date('2026-09-09T08:00:00Z') };
        prismaMock.analysisBatch.findFirst.mockResolvedValue(batch);
        prismaMock.analysisBatchItem.findMany.mockResolvedValue([]);
        prismaMock.analysisBatchItem.groupBy.mockResolvedValue([
            { status: 'QUEUED', _count: { _all: 3 }, _max: { updatedAt: batch.createdAt } },
        ]);
        prismaMock.analysisRun.groupBy.mockResolvedValue([
            { status: 'SUCCEEDED', _count: { _all: 3 }, _max: { completedAt } },
        ]);

        const response = await service.getOwnedAnalysisBatch('user-1', batchId);

        expect(response?.batch).toMatchObject({ status: 'COMPLETED', completedAt,
            counts: { total: 3, pending: 0, queued: 0, running: 0, succeeded: 3 } });
        expect(prismaMock.analysisBatch.findFirst).toHaveBeenCalledWith({ where: { id: batchId, userId: 'user-1' } });
        vi.doMock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'user-1' } }) }));
        const route = await import('@/app/api/analysis/batches/[id]/route');
        const http = await route.GET(new Request(`http://localhost/api/analysis/batches/${batchId}`), { params: Promise.resolve({ id: batchId }) });
        expect(http.status).toBe(200);
        expect(http.headers.get('cache-control')).toBe('private, no-store');
        expect(await http.json()).toMatchObject({ batch: { status: 'COMPLETED', completedAt: completedAt.toISOString(),
            counts: { pending: 0, queued: 0, running: 0, succeeded: 3 } } });
        expect(prismaMock.analysisBatch.update).not.toHaveBeenCalled();
        expect(prismaMock.analysisBatch.updateMany).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'mixed success and failure', items: ['QUEUED', 'ATTACHED'], runs: ['SUCCEEDED', 'FAILED'], expected: 'PARTIAL', queued: 0 },
        { name: 'all run failures', items: ['QUEUED'], runs: ['FAILED'], expected: 'FAILED', queued: 0 },
        { name: 'cancelled linked run', items: ['ATTACHED'], runs: ['CANCELLED'], expected: 'FAILED', queued: 0 },
        { name: 'skipped and failed planning', items: ['SKIPPED', 'FAILED'], runs: [], expected: 'PARTIAL', queued: 0 },
        { name: 'pending planning', items: ['PENDING'], runs: [], expected: 'PLANNING', queued: 0 },
        { name: 'active planning lease', items: ['PLANNING'], runs: [], expected: 'PLANNING', queued: 0 },
        { name: 'running linked run', items: ['QUEUED'], runs: ['RUNNING'], expected: 'QUEUED', queued: 0 },
        { name: 'queued linked run', items: ['QUEUED'], runs: ['QUEUED'], expected: 'QUEUED', queued: 1 },
        { name: 'missing linked run', items: ['QUEUED', 'ATTACHED'], runs: ['SUCCEEDED'], expected: 'QUEUED', queued: 1 },
        { name: 'cancelled planning item', items: ['CANCELLED'], runs: [], expected: 'FAILED', queued: 0 },
    ])('projects $name without prematurely completing unfinished work', async ({ items, runs, expected, queued }) => {
        const service = await importService();
        const completedAt = new Date('2026-09-09T08:00:30Z');
        prismaMock.analysisBatchItem.groupBy.mockResolvedValue(items.map(status => ({ status, _count: { _all: 1 }, _max: { updatedAt: completedAt } })));
        prismaMock.analysisRun.groupBy.mockResolvedValue(runs.map(status => ({ status, _count: { _all: 1 }, _max: { completedAt } })));
        const terminal = ['COMPLETED', 'PARTIAL', 'FAILED'].includes(expected);
        const response = await service.analysisBatchSummary({ id: 'batch-1', status: 'QUEUED',
            totalItems: items.length, completedAt: null } as never);
        expect(response.status).toBe(expected);
        expect(response.counts.queued).toBe(queued);
        expect(response.completedAt).toEqual(terminal ? completedAt : null);
    });

    it('preserves explicit batch cancellation and does not complete missing batch items', async () => {
        const service = await importService();
        const completedAt = new Date('2026-09-09T08:00:30Z');
        prismaMock.analysisBatchItem.groupBy.mockResolvedValue([]);
        prismaMock.analysisRun.groupBy.mockResolvedValue([]);
        const incomplete = await service.analysisBatchSummary({ id: 'batch-1', status: 'QUEUED', totalItems: 1, completedAt: null } as never);
        expect(incomplete).toMatchObject({ status: 'QUEUED', completedAt: null });
        const cancelled = await service.analysisBatchSummary({ id: 'batch-1', status: 'CANCELLED', totalItems: 1, completedAt } as never);
        expect(cancelled).toMatchObject({ status: 'CANCELLED', completedAt });
    });
});
