import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendMock, handleCallbackMock } = vi.hoisted(() => ({
    sendMock: vi.fn(),
    handleCallbackMock: vi.fn(),
}));

vi.mock('@vercel/queue', () => ({
    QueueClient: class {
        send = sendMock;
        handleCallback = handleCallbackMock;
    },
}));

async function importPublisher() {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BACKRANQ_DISABLE_VERCEL_QUEUE', 'false');
    return import('@/lib/queues/backranq');
}

describe('Backranq queue publisher', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it('returns a durable publish-failed result when the production SDK rejects', async () => {
        const queue = await importPublisher();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        sendMock.mockRejectedValueOnce(new Error('transient Queue outage'));

        await expect(
            queue.publishBackranqQueueMessage(
                { type: 'dispatch-analysis', requestedAt: '2026-08-12T00:00:00Z' },
                { idempotencyKey: 'dispatch-1' }
            )
        ).resolves.toMatchObject({
            queued: false,
            messageId: null,
            unavailableReason: 'publish-failed',
            error: expect.objectContaining({
                message: 'transient Queue outage',
            }),
        });
        expect(sendMock).toHaveBeenCalledWith(
            queue.BACKRANQ_QUEUE_TOPIC,
            expect.objectContaining({ type: 'dispatch-analysis' }),
            {
                idempotencyKey: 'dispatch-1',
                retentionSeconds: 86_400,
                delaySeconds: undefined,
            }
        );
    });
});
