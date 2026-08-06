import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

const planMock = vi.fn();
const staleMock = vi.fn();
const sourceHealthMock = vi.fn();
const deleteRateBucketsMock = vi.fn();
const deleteAnalyticsEventsMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    vi.doMock('@/lib/master/pipeline', () => ({
        planWeeklyMasterRun: planMock,
    }));
    vi.doMock('@/lib/master/publication', () => ({
        markStaleMasterPublications: staleMock,
        revalidateSelectedMasterSources: sourceHealthMock,
    }));
    vi.doMock('@/lib/prisma', () => ({
        prisma: {
            onboardingRateBucket: { deleteMany: deleteRateBucketsMock },
            onboardingAnalyticsEvent: {
                deleteMany: deleteAnalyticsEventsMock,
            },
        },
    }));
    return import('@/app/api/cron/weekly-master/route');
}

describe('GET /api/cron/weekly-master', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('CRON_SECRET', 'cron-secret');
        planMock.mockResolvedValue({
            run: { id: 'run-1', status: 'QUEUED' },
            published: { queued: true, messageId: 'message-1' },
        });
        staleMock.mockResolvedValue({ count: 2 });
        sourceHealthMock.mockResolvedValue({
            checked: 2,
            missing: 0,
            restored: 0,
        });
        deleteRateBucketsMock.mockResolvedValue({ count: 3 });
        deleteAnalyticsEventsMock.mockResolvedValue({ count: 4 });
    });

    it('rejects requests without the cron bearer secret', async () => {
        const route = await importRoute();
        const response = await route.GET(
            new Request('http://localhost/api/cron/weekly-master')
        );
        expect(response.status).toBe(401);
        expect(planMock).not.toHaveBeenCalled();
    });

    it('plans durable work and source-health maintenance', async () => {
        const route = await importRoute();
        const response = await route.GET(
            new Request('http://localhost/api/cron/weekly-master', {
                headers: { authorization: 'Bearer cron-secret' },
            })
        );
        expect(response.status).toBe(202);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            runId: 'run-1',
            queuePublished: true,
            stalePublications: 2,
            deletedRateBuckets: 3,
            deletedAnalyticsEvents: 4,
        });
    });
});
