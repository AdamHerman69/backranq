import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

type AnalysisJobsModule = typeof import('@/lib/services/analysisJobs');

async function importJobs(): Promise<AnalysisJobsModule> {
    vi.resetModules();
    mockPrismaModule();
    return import('@/lib/services/analysisJobs');
}

describe('analysis job enqueue service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not requeue a succeeded job unless forced', async () => {
        const service = await importJobs();
        const existing = {
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'SUCCEEDED',
            priority: 0,
            attempts: 1,
            lockedAt: null,
            startedAt: new Date(),
            completedAt: new Date(),
            lastError: null,
            queuedReason: 'auto-sync',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        prismaMock.analysisJob.findUnique.mockResolvedValue(existing);

        const result = await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
        });

        expect(result).toEqual({ job: existing, created: false, queued: false });
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.create).not.toHaveBeenCalled();
    });

    it('requeues a failed job with clean running state', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'FAILED',
            priority: 0,
            queuedReason: 'auto-sync',
        });
        prismaMock.analysisJob.update.mockResolvedValue({
            id: 'job-1',
            status: 'QUEUED',
        });

        const result = await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
            queuedReason: 'manual',
        });

        expect(result.queued).toBe(true);
        expect(prismaMock.analysisJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: 'QUEUED',
                lockedAt: null,
                startedAt: null,
                completedAt: null,
                lastError: null,
                queuedReason: 'manual',
            }),
        });
    });
});
