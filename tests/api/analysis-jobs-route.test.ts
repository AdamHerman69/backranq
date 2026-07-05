import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type AnalysisJobsRouteModule = typeof import('@/app/api/analysis/jobs/route');

const publishMock = vi.fn();

async function importRoute(): Promise<AnalysisJobsRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    return import('@/app/api/analysis/jobs/route');
}

function post(body: unknown) {
    return createJsonRequest('http://localhost/api/analysis/jobs', body, {
        method: 'POST',
    });
}

describe('POST /api/analysis/jobs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        publishMock.mockResolvedValue({ queued: true, messageId: 'msg-1' });
    });

    it('requires auth before enqueueing analysis jobs', async () => {
        setMockUserId(null);
        const route = await importRoute();

        const response = await route.POST(post({ gameIds: ['game-1'] }));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('queues only games owned by the current user', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
        });

        const response = await route.POST(
            post({ gameIds: ['game-1', 'other-user-game'] })
        );
        const body = await readJson<{ queued: number; skipped: number }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ queued: 1, skipped: 0 });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', id: { in: ['game-1', 'other-user-game'] } },
            select: { id: true },
        });
        expect(prismaMock.analysisJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                gameId: 'game-1',
                queuedReason: 'manual',
            }),
        });
        expect(publishMock).toHaveBeenCalledWith(
            { type: 'analysis-job', jobId: 'job-1' },
            { idempotencyKey: 'analysis:game-1' }
        );
    });

    it('uses a fresh queue idempotency key for forced re-analysis', async () => {
        const route = await importRoute();
        const updatedAt = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ id: 'game-1' }]);
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'SUCCEEDED',
            priority: 0,
            queuedReason: 'manual',
        });
        prismaMock.analysisJob.update.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            updatedAt,
        });

        const response = await route.POST(post({ gameIds: ['game-1'], force: true }));

        expect(response.status).toBe(200);
        expect(publishMock).toHaveBeenCalledWith(
            { type: 'analysis-job', jobId: 'job-1' },
            {
                idempotencyKey:
                    'analysis:game-1:reanalysis:2026-07-05T12:00:00.000Z',
            }
        );
    });
});
