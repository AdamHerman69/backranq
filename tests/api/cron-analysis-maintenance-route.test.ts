import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

const maintenanceCycleMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    vi.doMock('@/lib/services/analysisMaintenance', () => ({
        runAnalysisMaintenanceCycle: maintenanceCycleMock,
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
        maintenanceCycleMock.mockResolvedValue({
            skipped: null,
            recovery: { requeued: 0 },
            batchPlanRecovery: { recovered: 0 },
            batches: { completed: 0 },
            dispatch: { claimedJobIds: [] },
            settlements: { scanned: 0 },
            outbox: { claimed: 0 },
        });
    });

    it('rejects an unauthorized maintenance request before DB work', async () => {
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(maintenanceCycleMock).not.toHaveBeenCalled();
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
        });
        expect(maintenanceCycleMock).toHaveBeenCalledOnce();
    });

    it('skips overlapping maintenance without touching durable work', async () => {
        const route = await importRoute();
        maintenanceCycleMock.mockResolvedValue({
            skipped: 'already-running',
        });

        const response = await route.GET(request('cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            skipped: 'already-running',
        });
        expect(maintenanceCycleMock).toHaveBeenCalledOnce();
    });
});
