import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const notificationId = '10000000-0000-4000-8000-000000000001';

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/notifications/route');
}

describe('/api/notifications', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('returns only the authenticated user inbox and unread count', async () => {
        const createdAt = new Date('2026-08-04T10:00:00.000Z');
        prismaMock.notification.findMany.mockResolvedValue([
            {
                id: notificationId,
                userId: 'user-1',
                type: 'PRACTICE_READY',
                title: 'stale',
                body: 'stale',
                href: '/practice',
                metadata: {},
                itemCount: 3,
                secondaryCount: 1,
                dedupeKey: 'practice-ready:1',
                readAt: null,
                archivedAt: null,
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prismaMock.notification.count.mockResolvedValue(1);
        const route = await importRoute();

        const response = await route.GET(
            new Request('http://localhost/api/notifications?limit=10')
        );

        expect(response.status).toBe(200);
        expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'user-1', archivedAt: null } })
        );
        await expect(readJson(response)).resolves.toMatchObject({
            unreadCount: 1,
            notifications: [
                {
                    id: notificationId,
                    title: 'Your new practice is ready',
                    body: '3 practice positions from 1 analyzed game are ready.',
                },
            ],
        });
    });

    it('marks a notification read only within the authenticated owner scope', async () => {
        prismaMock.notification.updateMany.mockResolvedValue({ count: 1 });
        const route = await importRoute();
        const response = await route.POST(
            createJsonRequest('http://localhost/api/notifications', {
                action: 'mark-read',
                id: notificationId,
            })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.notification.updateMany).toHaveBeenCalledWith({
            where: { id: notificationId, userId: 'user-1', readAt: null },
            data: { readAt: expect.any(Date) },
        });
    });

    it('rejects malformed actions before database mutation', async () => {
        const route = await importRoute();
        const response = await route.POST(
            createJsonRequest('http://localhost/api/notifications', {
                action: 'mark-read',
                id: 'not-a-uuid',
            })
        );

        expect(response.status).toBe(400);
        expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated reads and writes', async () => {
        setMockUserId(null);
        const route = await importRoute();
        const read = await route.GET(new Request('http://localhost/api/notifications'));
        const write = await route.POST(
            createJsonRequest('http://localhost/api/notifications', {
                action: 'mark-all-read',
            })
        );

        expect(read.status).toBe(401);
        expect(write.status).toBe(401);
        expect(prismaMock.notification.findMany).not.toHaveBeenCalled();
        expect(prismaMock.notification.updateMany).not.toHaveBeenCalled();
    });
});
