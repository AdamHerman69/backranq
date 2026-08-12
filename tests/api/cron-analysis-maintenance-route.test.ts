import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

const heartbeatMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    vi.doMock('@/lib/services/analysisMaintenance', () => ({
        runAnalysisMaintenanceHeartbeat: heartbeatMock,
    }));
    return import('@/app/api/cron/analysis-maintenance/route');
}

function request(secret?: string) {
    return new Request('http://localhost/api/cron/analysis-maintenance', {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
}

describe('GET /api/cron/analysis-maintenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('CRON_SECRET', 'cron-secret');
        heartbeatMock.mockResolvedValue({
            skipped: null,
            recovery: { requeued: 0 },
            batchPlanRecovery: { recovered: 0 },
            batches: { completed: 0 },
            dispatch: { claimedJobIds: [] },
            settlements: { scanned: 0 },
            outbox: { claimed: 0 },
            nextHeartbeat: {
                queued: true,
                messageId: 'heartbeat-1',
                scheduledAt: '2026-08-12T12:01:00.000Z',
            },
        });
    });

    it('rejects an unauthorized maintenance request before DB work', async () => {
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(heartbeatMock).not.toHaveBeenCalled();
    });

    it('recovers, stages, settles, and flushes under a durable lease', async () => {
        const route = await importRoute();

        const response = await route.GET(request('cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            skipped: null,
            recovery: { requeued: 0 },
            batchPlanRecovery: { recovered: 0 },
            batches: { completed: 0 },
            dispatch: { claimedJobIds: [] },
            settlements: { scanned: 0 },
            outbox: { claimed: 0 },
            nextHeartbeat: {
                queued: true,
                messageId: 'heartbeat-1',
            },
        });
        expect(heartbeatMock).toHaveBeenCalledOnce();
    });

    it('skips overlapping maintenance without touching durable work', async () => {
        const route = await importRoute();
        heartbeatMock.mockResolvedValue({
            skipped: 'already-running',
            nextHeartbeat: {
                queued: true,
                messageId: 'heartbeat-2',
                scheduledAt: '2026-08-12T12:01:00.000Z',
            },
        });

        const response = await route.GET(request('cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            skipped: 'already-running',
            nextHeartbeat: { queued: true, messageId: 'heartbeat-2' },
        });
        expect(heartbeatMock).toHaveBeenCalledOnce();
    });
});
