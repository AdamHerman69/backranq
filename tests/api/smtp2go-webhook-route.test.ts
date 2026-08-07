import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

async function importRoute() {
    vi.resetModules();
    mockPrismaModule();
    return import('@/app/api/webhooks/smtp2go/route');
}

function webhookRequest(
    body: Record<string, unknown>,
    authorization = 'Bearer webhook-test-secret'
) {
    return new Request('http://localhost/api/webhooks/smtp2go', {
        method: 'POST',
        headers: {
            authorization,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
}

describe('POST /api/webhooks/smtp2go', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('SMTP2GO_WEBHOOK_SECRET', 'webhook-test-secret');
        prismaMock.notificationDelivery.findUnique.mockResolvedValue({
            id: 'delivery-1',
            userId: 'user-1',
            status: 'SENT',
        });
        prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
        );
    });

    it('rejects requests without the configured bearer secret', async () => {
        const route = await importRoute();
        const response = await route.POST(
            webhookRequest(
                { event: 'delivered', email_id: 'smtp2go-email-1' },
                'Bearer wrong-secret'
            )
        );

        expect(response.status).toBe(401);
        expect(prismaMock.notificationDelivery.findUnique).not.toHaveBeenCalled();
    });

    it('marks delivered messages with the SMTP2GO email id', async () => {
        const route = await importRoute();
        const response = await route.POST(
            webhookRequest({
                event: 'delivered',
                email_id: 'smtp2go-email-1',
            })
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ received: true });
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: {
                    in: ['PENDING', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED'],
                },
            },
            data: {
                status: 'DELIVERED',
                deliveredAt: expect.any(Date),
            },
        });
    });

    it('suppresses future email after a hard bounce', async () => {
        const route = await importRoute();
        const response = await route.POST(
            webhookRequest({
                event: 'bounce',
                bounce: 'hard',
                email_id: 'smtp2go-email-2',
            })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenNthCalledWith(1, {
            where: {
                id: 'delivery-1',
                status: {
                    in: [
                        'PENDING',
                        'QUEUED',
                        'PROCESSING',
                        'SENT',
                        'FAILED',
                        'DELIVERED',
                    ],
                },
            },
            data: { status: 'BOUNCED' },
        });
        expect(prismaMock.notificationPreference.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'user-1' } })
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                channel: 'EMAIL',
                status: { in: ['PENDING', 'QUEUED'] },
            },
            data: {
                status: 'SUPPRESSED',
                dispatchToken: null,
                lockedUntil: null,
            },
        });
    });

    it('records a soft bounce without globally suppressing the user', async () => {
        const route = await importRoute();
        const response = await route.POST(
            webhookRequest({
                event: 'bounce',
                bounce: 'soft',
                email_id: 'smtp2go-email-3',
            })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'SENT'] },
            },
            data: { status: 'FAILED' },
        });
        expect(prismaMock.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it('uses the requested custom header when the webhook beats provider id persistence', async () => {
        prismaMock.notificationDelivery.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'delivery-race',
                userId: 'user-1',
                status: 'PROCESSING',
            });
        const route = await importRoute();
        const response = await route.POST(
            webhookRequest({
                event: 'delivered',
                email_id: 'smtp2go-race',
                'X-Backranq-Delivery-Id': 'delivery-race',
            })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.notificationDelivery.findUnique).toHaveBeenNthCalledWith(2, {
            where: { id: 'delivery-race' },
            select: { id: true, userId: true, status: true },
        });
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-race',
                status: {
                    in: ['PENDING', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED'],
                },
            },
            data: {
                status: 'DELIVERED',
                deliveredAt: expect.any(Date),
                sentAt: expect.any(Date),
                providerMessageId: 'smtp2go-race',
            },
        });
    });

    it('does not let a delivered callback overwrite a bounce or complaint', async () => {
        const route = await importRoute();
        await route.POST(
            webhookRequest({ event: 'delivered', email_id: 'smtp2go-email-4' })
        );

        const update = prismaMock.notificationDelivery.updateMany.mock.calls[0]?.[0] as {
            where: { status: { in: string[] } };
        };
        expect(update.where.status.in).not.toContain('BOUNCED');
        expect(update.where.status.in).not.toContain('COMPLAINED');
        expect(update.where.status.in).not.toContain('SUPPRESSED');
    });
});
