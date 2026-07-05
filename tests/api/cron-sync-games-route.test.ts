import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

type CronRouteModule = typeof import('@/app/api/cron/sync-games/route');

const publishMock = vi.fn();
const syncLinkedAccountsMock = vi.fn();

async function importRoute(): Promise<CronRouteModule> {
    vi.resetModules();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/services/autoSync', () => ({
        syncLinkedAccounts: syncLinkedAccountsMock,
    }));
    return import('@/app/api/cron/sync-games/route');
}

function request(secret?: string) {
    return new Request('http://localhost/api/cron/sync-games', {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
}

describe('GET /api/cron/sync-games', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('CRON_SECRET', 'test-cron-secret');
        publishMock.mockResolvedValue({ queued: true, messageId: 'msg-1' });
        syncLinkedAccountsMock.mockResolvedValue({ usersScanned: 0, providers: [] });
    });

    it('requires the cron secret before doing work', async () => {
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(publishMock).not.toHaveBeenCalled();
        expect(syncLinkedAccountsMock).not.toHaveBeenCalled();
    });

    it('publishes a sync message when queueing succeeds', async () => {
        const route = await importRoute();

        const response = await route.GET(request('test-cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            queued: true,
            messageId: 'msg-1',
        });
        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'sync-all' }),
            expect.objectContaining({ idempotencyKey: expect.stringMatching(/^sync-all:/) })
        );
        expect(syncLinkedAccountsMock).not.toHaveBeenCalled();
    });

    it('runs sync inline when queue publishing is unavailable', async () => {
        publishMock.mockResolvedValue({ queued: false, messageId: null });
        const route = await importRoute();

        const response = await route.GET(request('test-cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            queued: false,
            result: { usersScanned: 0 },
        });
        expect(syncLinkedAccountsMock).toHaveBeenCalledTimes(1);
    });
});
