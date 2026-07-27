import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

type AdminOpsRouteModule = typeof import('@/app/api/admin/analysis-ops/route');

const getAnalysisOpsSnapshotMock = vi.fn();

async function importRoute(): Promise<AdminOpsRouteModule> {
    vi.resetModules();
    vi.doMock('@/lib/services/analysisOps', () => ({
        getAnalysisOpsSnapshot: getAnalysisOpsSnapshotMock,
    }));
    return import('@/app/api/admin/analysis-ops/route');
}

function request(secret?: string) {
    return new Request('http://localhost/api/admin/analysis-ops', {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
}

describe('GET /api/admin/analysis-ops', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        getAnalysisOpsSnapshotMock.mockResolvedValue({
            analysisJobs: {
                queued: 1,
                running: 2,
                failed: 3,
                lockedQueued: 4,
                stuckRunning: 5,
            },
            syncJobs: {
                queued: 6,
                running: 7,
                failed: 8,
                stuckRunning: 9,
            },
            credits: {
                reserved: 10,
                consumed: 11,
                refunded: 12,
                released: 13,
            },
        });
    });

    it('is hidden when no admin secret is configured', async () => {
        const route = await importRoute();

        const response = await route.GET(request());

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
        expect(getAnalysisOpsSnapshotMock).not.toHaveBeenCalled();
    });

    it('requires the configured admin bearer token', async () => {
        vi.stubEnv('BACKRANQ_ADMIN_API_SECRET', 'ops-secret');
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(getAnalysisOpsSnapshotMock).not.toHaveBeenCalled();
    });

    it('returns the ops snapshot for an authorized request', async () => {
        vi.stubEnv('BACKRANQ_ADMIN_API_SECRET', 'ops-secret');
        const route = await importRoute();

        const response = await route.GET(request('ops-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            snapshot: {
                analysisJobs: { queued: 1 },
                syncJobs: { queued: 6 },
                credits: { reserved: 10 },
            },
        });
        expect(getAnalysisOpsSnapshotMock).toHaveBeenCalledTimes(1);
    });
});
