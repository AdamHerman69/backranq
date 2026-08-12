import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const recoverMock = vi.fn();
const dispatchMock = vi.fn();
const flushMock = vi.fn();
const settlementsMock = vi.fn();
const batchPlanRecoveryMock = vi.fn();
const batchCompletionsMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        recoverExpiredAnalysisJobs: recoverMock,
        dispatchQueuedAnalysisJobs: dispatchMock,
    }));
    vi.doMock('@/lib/services/analysisOutbox', () => ({
        flushAnalysisOutbox: flushMock,
    }));
    vi.doMock('@/lib/services/analysisOps', () => ({
        reconcileAnalysisCreditSettlements: settlementsMock,
    }));
    vi.doMock('@/lib/services/analysisBatches', () => ({
        recoverAnalysisBatchPlanOutbox: batchPlanRecoveryMock,
        reconcileAnalysisBatchCompletions: batchCompletionsMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
    );
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
        prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
            const text = JSON.stringify(query);
            const token = text.match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
            )?.[0];
            return [{ leaseToken: token }];
        });
        prismaMock.analysisMaintenanceLease.updateMany.mockResolvedValue({
            count: 1,
        });
        recoverMock.mockResolvedValue({ requeued: 0, failed: 0 });
        dispatchMock.mockResolvedValue({ claimedJobIds: [] });
        settlementsMock.mockResolvedValue({ scanned: 0, errors: [] });
        flushMock.mockResolvedValue({ claimed: 0, published: 0 });
        batchPlanRecoveryMock.mockResolvedValue({ scanned: 0, recovered: 0 });
        batchCompletionsMock.mockResolvedValue({
            scanned: 0,
            completed: 0,
            partial: 0,
            failed: 0,
        });
    });

    it('rejects an unauthorized maintenance request before DB work', async () => {
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
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
        expect(recoverMock).toHaveBeenCalledOnce();
        expect(batchPlanRecoveryMock).toHaveBeenCalledOnce();
        expect(batchCompletionsMock).toHaveBeenCalledOnce();
        expect(dispatchMock).toHaveBeenCalledOnce();
        expect(settlementsMock).toHaveBeenCalledOnce();
        expect(flushMock).toHaveBeenCalledOnce();
        expect(
            prismaMock.analysisMaintenanceLease.updateMany
        ).toHaveBeenCalledWith({
            where: {
                key: 'analysis-maintenance',
                leaseToken: expect.any(String),
            },
            data: { lockedUntil: expect.any(Date) },
        });
    });

    it('skips overlapping maintenance without touching durable work', async () => {
        const route = await importRoute();
        prismaMock.$queryRaw.mockResolvedValue([]);

        const response = await route.GET(request('cron-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            ok: true,
            skipped: 'already-running',
        });
        expect(recoverMock).not.toHaveBeenCalled();
        expect(dispatchMock).not.toHaveBeenCalled();
        expect(flushMock).not.toHaveBeenCalled();
        expect(
            prismaMock.analysisMaintenanceLease.updateMany
        ).not.toHaveBeenCalled();
    });
});
