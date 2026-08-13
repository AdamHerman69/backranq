import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const preference = {
    userId: 'user-1',
    emailPracticeReady: true,
    emailAnalysisFailed: false,
    emailSyncSummary: true,
    emailBilling: true,
    emailWeeklyProgress: true,
    emailProductNews: false,
    pushEnabled: false,
    syncDigestFrequency: 'DAILY',
    timezone: 'Europe/Prague',
    digestHour: 8,
    productNewsConsentedAt: null,
    optionalEmailsUnsubscribedAt: null,
    emailSuppressedAt: null,
};

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/notifications/preferences/route');
}

describe('/api/notifications/preferences owner contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.notificationPreference.upsert.mockResolvedValue(preference);
        prismaMock.notificationPreference.update.mockResolvedValue(preference);
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
        );
    });

    it('returns the authenticated owner with preferences', async () => {
        const route = await importRoute();
        const response = await route.GET();

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            preferences: { timezone: 'Europe/Prague' },
        });
    });

    it('rejects a stale owner before parsing or writing preferences', async () => {
        const route = await importRoute();
        const response = await route.PATCH(
            createJsonRequest(
                'http://localhost/api/notifications/preferences',
                { emailPracticeReady: false },
                { headers: { 'X-Backranq-Owner-Id': 'user-a' }, method: 'PATCH' }
            )
        );

        expect(response.status).toBe(409);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.notificationPreference.update).not.toHaveBeenCalled();
    });

    it('returns the owner after a fenced preference write', async () => {
        const route = await importRoute();
        const response = await route.PATCH(
            createJsonRequest(
                'http://localhost/api/notifications/preferences',
                { emailPracticeReady: false },
                { headers: { 'X-Backranq-Owner-Id': 'user-1' }, method: 'PATCH' }
            )
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            preferences: { timezone: 'Europe/Prague' },
        });
    });
});
