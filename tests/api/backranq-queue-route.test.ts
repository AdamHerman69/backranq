import { describe, expect, it, vi } from 'vitest';
import { WeeklyMasterTerminalError } from '@/lib/master/pipelineErrors';
import { SyncJobDeliveryDeferredError } from '@/lib/services/syncJobErrors';

vi.mock('@/lib/queues/backranq', () => ({
    handleBackranqQueueCallback: vi.fn(
        (_handler: unknown, options: unknown) => ({ options })
    ),
}));
vi.mock('@/lib/services/backranqQueueProcessor', () => ({
    processBackranqQueueMessage: vi.fn(),
}));
vi.mock('@/lib/services/analysisOutbox', () => ({
    normalizeError: (error: unknown) => ({ message: String(error) }),
}));

describe('Backranq Queue callback retry policy', () => {
    it('acknowledges an explicitly terminal durable run', async () => {
        const route = await import('@/app/api/queues/backranq-jobs/route');

        expect(
            route.backranqQueueRetry(
                new WeeklyMasterTerminalError('attempts exhausted'),
                { deliveryCount: 41 }
            )
        ).toEqual({ acknowledge: true });
    });

    it('never blindly acknowledges infrastructure failures', async () => {
        const route = await import('@/app/api/queues/backranq-jobs/route');

        expect(
            route.backranqQueueRetry(new Error('database unavailable'), {
                deliveryCount: 100,
            })
        ).toEqual({ afterSeconds: 300 });
    });

    it('uses the durable sync lease retry delay without exceeding queue bounds', async () => {
        const route = await import('@/app/api/queues/backranq-jobs/route');

        expect(
            route.backranqQueueRetry(
                new SyncJobDeliveryDeferredError('sync-job-1', 600),
                { deliveryCount: 2 }
            )
        ).toEqual({ afterSeconds: 300 });
        expect(
            route.backranqQueueRetry(
                new SyncJobDeliveryDeferredError('sync-job-1', 17),
                { deliveryCount: 2 }
            )
        ).toEqual({ afterSeconds: 17 });
    });
});
