import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const publishMock = vi.fn();
const cancelUnavailableAnalysisBatchMock = vi.fn();
const cancelUnexecutableAnalysisJobsMock = vi.fn();
const refreshAnalysisBatchAggregateMock = vi.fn();

async function importOutbox() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/services/analysisQueueCancellation', () => ({
        cancelUnavailableAnalysisBatch: cancelUnavailableAnalysisBatchMock,
        cancelUnexecutableAnalysisJobs: cancelUnexecutableAnalysisJobsMock,
    }));
    vi.doMock('@/lib/services/analysisBatches', () => ({
        refreshAnalysisBatchAggregate: refreshAnalysisBatchAggregateMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
    );
    return import('@/lib/services/analysisOutbox');
}

function claimedRow() {
    return {
        id: 'outbox-1',
        batchId: null,
        analysisJobId: 'job-1',
        kind: 'ANALYSIS_JOB',
        idempotencyKey: 'analysis:game-1:job-1:delivery:1',
        payload: {
            type: 'analysis-job',
            jobId: 'job-1',
            dispatchToken: 'token-1',
        },
        attempts: 1,
        leaseToken: '00000000-0000-4000-8000-000000000001',
    };
}

describe('analysis outbox publisher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.analysisOutbox.updateMany.mockResolvedValue({ count: 1 });
        cancelUnavailableAnalysisBatchMock.mockResolvedValue({ cancelled: 0 });
        cancelUnexecutableAnalysisJobsMock.mockResolvedValue({ cancelled: 0 });
        refreshAnalysisBatchAggregateMock.mockResolvedValue({ remaining: 0 });
    });

    it('returns a rejected publish to pending state with bounded backoff', async () => {
        const outbox = await importOutbox();
        prismaMock.$queryRaw.mockResolvedValue([claimedRow()]);
        publishMock.mockResolvedValue({
            queued: false,
            messageId: null,
            unavailableReason: 'publish-failed',
            error: new Error('queue offline'),
        });
        const now = new Date('2026-08-12T00:00:00.000Z');

        const result = await outbox.flushAnalysisOutbox({ now });

        expect(result).toMatchObject({ claimed: 1, published: 0, pending: 1 });
        expect(prismaMock.analysisOutbox.updateMany).toHaveBeenLastCalledWith({
            where: {
                id: 'outbox-1',
                status: 'LEASED',
                leaseToken: '00000000-0000-4000-8000-000000000001',
            },
            data: expect.objectContaining({
                status: 'PENDING',
                lastError: 'queue offline',
                leaseToken: null,
                lockedUntil: null,
                availableAt: new Date('2026-08-12T00:00:15.000Z'),
            }),
        });
    });

    it('keeps send/commit ambiguity leased for safe same-key redelivery', async () => {
        const outbox = await importOutbox();
        prismaMock.$queryRaw.mockResolvedValue([claimedRow()]);
        publishMock.mockResolvedValue({ queued: true, messageId: 'message-1' });
        prismaMock.analysisOutbox.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockRejectedValueOnce(new Error('database unavailable after send'));

        const result = await outbox.flushAnalysisOutbox();

        expect(result).toMatchObject({ claimed: 1, ambiguous: 1 });
        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'analysis-job', jobId: 'job-1' }),
            {
                idempotencyKey: 'analysis:game-1:job-1:delivery:1',
            }
        );
        expect(result.items[0]).toMatchObject({
            queued: true,
            status: 'LEASED',
            messageId: 'message-1',
        });
    });

    it('terminally cancels and refunds a batch when the queue is disabled', async () => {
        const outbox = await importOutbox();
        prismaMock.$queryRaw.mockResolvedValue([
            {
                ...claimedRow(),
                kind: 'ANALYSIS_BATCH_PLAN',
                batchId: 'batch-1',
                analysisJobId: null,
                payload: { type: 'analysis-batch', batchId: 'batch-1' },
            },
        ]);
        publishMock.mockResolvedValue({
            queued: false,
            messageId: null,
            unavailableReason: 'disabled',
        });

        const result = await outbox.flushAnalysisOutbox();

        expect(result).toMatchObject({ claimed: 1, failed: 1, pending: 0 });
        expect(cancelUnavailableAnalysisBatchMock).toHaveBeenCalledWith({
            batchId: 'batch-1',
            reason: 'Server analysis queue is disabled',
        });
        expect(refreshAnalysisBatchAggregateMock).toHaveBeenCalledWith(
            'batch-1'
        );
        expect(prismaMock.analysisOutbox.updateMany).toHaveBeenLastCalledWith({
            where: {
                id: 'outbox-1',
                status: 'LEASED',
                leaseToken: '00000000-0000-4000-8000-000000000001',
            },
            data: {
                status: 'FAILED',
                leaseToken: null,
                lockedUntil: null,
                lastError: 'Server analysis queue is disabled',
            },
        });
    });
});
