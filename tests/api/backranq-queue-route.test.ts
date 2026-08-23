import { describe, expect, it, vi } from 'vitest';
import { WeeklyMasterTerminalError } from '@/lib/master/pipelineErrors';

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
});
