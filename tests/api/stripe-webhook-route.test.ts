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
        prismaMock.stripeWebhookEvent.upsert.mockResolvedValue({
            id: 'evt_1',
            type: 'checkout.session.completed',
            status: 'PROCESSING',
        });
        prismaMock.stripeWebhookEvent.update.mockResolvedValue({
            id: 'evt_1',
            status: 'SUCCEEDED',
        });
    });

    it('verifies the Stripe signature before handling an event', async () => {
        const event = {
            id: 'evt_1',
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
            event.data.object
        );
        expect(prismaMock.stripeWebhookEvent.upsert).toHaveBeenCalledWith({
            where: { id: 'evt_1' },
            update: expect.objectContaining({
                status: 'PROCESSING',
                attempts: { increment: 1 },
            }),
            create: {
                id: 'evt_1',
                type: 'checkout.session.completed',
                status: 'PROCESSING',
            },
        });
        expect(prismaMock.stripeWebhookEvent.update).toHaveBeenCalledWith({
            where: { id: 'evt_1' },
            data: expect.objectContaining({ status: 'SUCCEEDED' }),
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
        expect(applyStripeSubscriptionMock).toHaveBeenCalledWith(subscription);
    });

    it('marks handler failures as failed webhook events', async () => {
        constructEventMock.mockReturnValue({
            id: 'evt_fail',
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_1' } },
        });
        applyStripeSubscriptionMock.mockRejectedValue(
            new Error('Could not map Stripe subscription')
        );
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(500);
        expect(prismaMock.stripeWebhookEvent.update).toHaveBeenCalledWith({
            where: { id: 'evt_fail' },
            data: {
                status: 'FAILED',
                lastError: 'Could not map Stripe subscription',
            },
        });
    });

    it('retries previously failed webhook events', async () => {
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue({
            status: 'FAILED',
        });
        constructEventMock.mockReturnValue({
            id: 'evt_retry',
            type: 'customer.subscription.deleted',
            data: { object: { id: 'sub_1' } },
        });
        const route = await importRoute();

        const response = await route.POST(webhookRequest());

        expect(response.status).toBe(200);
        expect(prismaMock.stripeWebhookEvent.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'evt_retry' },
                update: expect.objectContaining({
                    status: 'PROCESSING',
                    attempts: { increment: 1 },
                }),
            })
        );
        expect(markStripeSubscriptionDeletedMock).toHaveBeenCalledWith({
            id: 'sub_1',
        });
    });

    it('acknowledges already processed duplicate events without reapplying billing', async () => {
        prismaMock.stripeWebhookEvent.findUnique.mockResolvedValue({
            status: 'SUCCEEDED',
        });
        constructEventMock.mockReturnValue({
            id: 'evt_duplicate',
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
        expect(prismaMock.stripeWebhookEvent.upsert).not.toHaveBeenCalled();
    });
});
