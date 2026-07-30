import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type WebhookRouteModule = typeof import('@/app/api/stripe/webhook/route');

const constructEventMock = vi.fn();
const subscriptionsRetrieveMock = vi.fn();
const applyStripeCheckoutSessionMock = vi.fn();
const applyStripeSubscriptionMock = vi.fn();
const markStripeSubscriptionDeletedMock = vi.fn();

async function importRoute(): Promise<WebhookRouteModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/stripe', () => ({
        getStripeClient: () => ({
            webhooks: { constructEvent: constructEventMock },
            subscriptions: { retrieve: subscriptionsRetrieveMock },
        }),
    }));
    vi.doMock('@/lib/services/stripeBilling', () => ({
        applyStripeCheckoutSession: applyStripeCheckoutSessionMock,
        applyStripeSubscription: applyStripeSubscriptionMock,
        markStripeSubscriptionDeleted: markStripeSubscriptionDeletedMock,
    }));
    return import('@/app/api/stripe/webhook/route');
}

function webhookRequest(body = '{}', signature = 'sig_test') {
    return new Request('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signature },
        body,
    });
}

describe('POST /api/stripe/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
        vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue(null);
        prismaMock.stripeWebhookEvent.create.mockResolvedValue({
            id: 'evt_1',
            type: 'checkout.session.completed',
            status: 'PROCESSING',
        });
        prismaMock.stripeWebhookEvent.updateMany.mockResolvedValue({
            count: 1,
        });
    });

    it('verifies the Stripe signature before handling an event', async () => {
        const event = {
            id: 'evt_1',
            created: 1_800_000_000,
            type: 'checkout.session.completed',
            data: { object: { id: 'cs_test_1' } },
        };
        constructEventMock.mockReturnValue(event);
        const route = await importRoute();

        const response = await route.POST(webhookRequest('{"id":"evt_1"}'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ received: true });
        expect(constructEventMock).toHaveBeenCalledWith(
            '{"id":"evt_1"}',
            'sig_test',
            'whsec_test'
        );
        expect(applyStripeCheckoutSessionMock).toHaveBeenCalledWith(
            event.data.object,
            {
                eventId: 'evt_1',
                eventCreatedAt: new Date(1_800_000_000_000),
            }
        );
        expect(prismaMock.stripeWebhookEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: 'evt_1',
                type: 'checkout.session.completed',
                status: 'PROCESSING',
                processingToken: expect.any(String),
                processingUntil: expect.any(Date),
            }),
        });
        expect(prismaMock.stripeWebhookEvent.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: 'evt_1',
                status: 'PROCESSING',
                processingToken: expect.any(String),
            }),
            data: expect.objectContaining({
                status: 'SUCCEEDED',
                processingToken: null,
                processingUntil: null,
            }),
        });
    });

    it('rejects invalid signatures', async () => {
        constructEventMock.mockImplementation(() => {
            throw new Error('bad signature');
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid signature',
        });
        expect(applyStripeCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it('syncs invoice events through the subscription object', async () => {
        const subscription = { id: 'sub_1', status: 'active' };
        constructEventMock.mockReturnValue({
            id: 'evt_invoice_1',
            created: 1_800_000_000,
            type: 'invoice.paid',
            data: { object: { subscription: 'sub_1' } },
        });
        subscriptionsRetrieveMock.mockResolvedValue(subscription);
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(200);
        expect(subscriptionsRetrieveMock).toHaveBeenCalledWith('sub_1', {
            expand: ['items.data.price'],
        });
        expect(applyStripeSubscriptionMock).toHaveBeenCalledWith(
            subscription,
            {
                eventId: 'evt_invoice_1',
                eventCreatedAt: new Date(1_800_000_000_000),
            }
        );
    });

    it('marks handler failures as failed webhook events', async () => {
        constructEventMock.mockReturnValue({
            id: 'evt_fail',
            created: 1_800_000_000,
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_1' } },
        });
        subscriptionsRetrieveMock.mockResolvedValue({
            id: 'sub_1',
            status: 'active',
        });
        applyStripeSubscriptionMock.mockRejectedValue(
            new Error('Could not map Stripe subscription')
        );
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(500);
        expect(prismaMock.stripeWebhookEvent.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: 'evt_fail',
                status: 'PROCESSING',
                processingToken: expect.any(String),
            }),
            data: expect.objectContaining({
                status: 'FAILED',
                processingToken: null,
                processingUntil: null,
                lastError: 'Could not map Stripe subscription',
            }),
        });
    });

    it('retries previously failed webhook events', async () => {
        prismaMock.stripeWebhookEvent.create.mockRejectedValue({
            code: 'P2002',
        });
        prismaMock.stripeWebhookEvent.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue({
            status: 'FAILED',
        });
        constructEventMock.mockReturnValue({
            id: 'evt_retry',
            created: 1_800_000_000,
            type: 'customer.subscription.deleted',
            data: { object: { id: 'sub_1' } },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(200);
        expect(prismaMock.stripeWebhookEvent.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'evt_retry',
                    OR: expect.any(Array),
                }),
                data: expect.objectContaining({
                    status: 'PROCESSING',
                    attempts: { increment: 1 },
                    processingToken: expect.any(String),
                    processingUntil: expect.any(Date),
                }),
            })
        );
        expect(markStripeSubscriptionDeletedMock).toHaveBeenCalledWith(
            { id: 'sub_1' },
            {
                eventId: 'evt_retry',
                eventCreatedAt: new Date(1_800_000_000_000),
            }
        );
    });

    it('acknowledges already processed duplicate events without reapplying billing', async () => {
        prismaMock.stripeWebhookEvent.create.mockRejectedValue({
            code: 'P2002',
        });
        prismaMock.stripeWebhookEvent.updateMany.mockResolvedValue({
            count: 0,
        });
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue({
            status: 'SUCCEEDED',
        });
        constructEventMock.mockReturnValue({
            id: 'evt_duplicate',
            created: 1_800_000_000,
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_1' } },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            received: true,
            duplicate: true,
        });
        expect(applyStripeSubscriptionMock).not.toHaveBeenCalled();
    });

    it('returns a retryable response while another fresh lease owns the event', async () => {
        prismaMock.stripeWebhookEvent.create.mockRejectedValue({
            code: 'P2002',
        });
        prismaMock.stripeWebhookEvent.updateMany.mockResolvedValue({
            count: 0,
        });
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue({
            status: 'PROCESSING',
        });
        constructEventMock.mockReturnValue({
            id: 'evt_processing',
            created: 1_800_000_000,
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_1' } },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(503);
        expect(applyStripeSubscriptionMock).not.toHaveBeenCalled();
    });

    it('atomically takes over an expired processing lease', async () => {
        prismaMock.stripeWebhookEvent.create.mockRejectedValue({
            code: 'P2002',
        });
        prismaMock.stripeWebhookEvent.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });
        constructEventMock.mockReturnValue({
            id: 'evt_stale',
            created: 1_800_000_000,
            type: 'unhandled.test.event',
            data: { object: {} },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(200);
        expect(prismaMock.stripeWebhookEvent.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: {
                    id: 'evt_stale',
                    OR: [
                        { status: 'FAILED' },
                        {
                            status: 'PROCESSING',
                            OR: [
                                { processingUntil: null },
                                {
                                    processingUntil: {
                                        lt: expect.any(Date),
                                    },
                                },
                            ],
                        },
                    ],
                },
            })
        );
    });

    it('fails retryably when completion loses its processing fence', async () => {
        prismaMock.stripeWebhookEvent.updateMany.mockResolvedValue({
            count: 0,
        });
        constructEventMock.mockReturnValue({
            id: 'evt_lost_lease',
            created: 1_800_000_000,
            type: 'unhandled.test.event',
            data: { object: {} },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(500);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Stripe webhook processing lease was lost',
        });
    });
});
