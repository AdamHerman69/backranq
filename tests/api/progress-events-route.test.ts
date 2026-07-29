import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createJsonRequest,
    readJson,
} from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const now = new Date('2026-07-30T12:00:00.000Z');
const clientEventId =
    '10000000-0000-4000-8000-000000000001';

async function importProgressEventsRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/progress/events/route');
}

async function importPracticeExposuresRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/training/exposures/route');
}

describe('bounded Progress evidence routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        setMockUserId('user-1');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('authenticates and persists a typed Progress analytics event', async () => {
        prismaMock.progressAnalyticsEvent.create.mockResolvedValue({
            id: 'event-1',
        });
        prismaMock.$queryRaw.mockResolvedValue([
            { eventCount: 1 },
        ]);
        const route = await importProgressEventsRoute();

        const response = await route.POST(
            createJsonRequest(
                'http://localhost/api/progress/events',
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId,
                    occurredAt: now.toISOString(),
                    windowDays: 90,
                }
            )
        );

        expect(response.status).toBe(202);
        expect(response.headers.get('cache-control')).toBe(
            'private, no-store'
        );
        expect(
            prismaMock.progressAnalyticsEvent.create
        ).toHaveBeenCalledOnce();
    });

    it('accepts but does not store analytics above the per-user minute cap', async () => {
        prismaMock.$queryRaw.mockResolvedValue([]);
        const route = await importProgressEventsRoute();

        const response = await route.POST(
            createJsonRequest(
                'http://localhost/api/progress/events',
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId,
                    occurredAt: now.toISOString(),
                }
            )
        );

        expect(response.status).toBe(202);
        await expect(readJson(response)).resolves.toMatchObject({
            recorded: false,
            rateLimited: true,
        });
        expect(
            prismaMock.progressAnalyticsEvent.create
        ).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated and oversized analytics writes', async () => {
        const route = await importProgressEventsRoute();
        setMockUserId(null);
        const unauthorized = await route.POST(
            createJsonRequest(
                'http://localhost/api/progress/events',
                {}
            )
        );
        expect(unauthorized.status).toBe(401);

        setMockUserId('user-1');
        const oversized = await route.POST(
            createJsonRequest(
                'http://localhost/api/progress/events',
                { padding: 'x'.repeat(5_000) }
            )
        );
        expect(oversized.status).toBe(413);
        expect(
            prismaMock.progressAnalyticsEvent.create
        ).not.toHaveBeenCalled();
    });

    it('records an owned Practice exposure and rejects another owner', async () => {
        prismaMock.trainingMoment.findFirst
            .mockResolvedValueOnce({
                id: '10000000-0000-4000-8000-000000000003',
                currentSolutionRevisionId:
                    '10000000-0000-4000-8000-000000000004',
            })
            .mockResolvedValueOnce(null);
        prismaMock.practiceExposure.create.mockResolvedValue({
            id: 'exposure-1',
        });
        const route = await importPracticeExposuresRoute();
        const body = {
            kind: 'SHOWN',
            clientExposureId:
                '10000000-0000-4000-8000-000000000002',
            clientEventId,
            momentId:
                '10000000-0000-4000-8000-000000000003',
            solutionRevisionId:
                '10000000-0000-4000-8000-000000000004',
            shownAt: now.toISOString(),
            occurredAt: now.toISOString(),
            entry: 'progress',
            recommendationKey: 'review-position',
        };

        const accepted = await route.POST(
            createJsonRequest(
                'http://localhost/api/training/exposures',
                body
            )
        );
        expect(accepted.status).toBe(202);
        expect(
            prismaMock.practiceExposure.create
        ).toHaveBeenCalledOnce();

        const missing = await route.POST(
            createJsonRequest(
                'http://localhost/api/training/exposures',
                {
                    ...body,
                    clientEventId:
                        '10000000-0000-4000-8000-000000000005',
                }
            )
        );
        expect(missing.status).toBe(404);
        await expect(readJson(missing)).resolves.toMatchObject({
            code: 'NOT_FOUND',
        });
    });
});
