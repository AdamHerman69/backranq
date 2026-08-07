import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

type CheckoutRouteModule = typeof import('@/app/api/stripe/checkout/route');

const createStripeCheckoutSessionMock = vi.fn();
class ComplimentaryCheckoutNotAllowedError extends Error {}
class ActiveSubscriptionRequiresPortalError extends Error {}
class CheckoutAlreadyInProgressError extends Error {}

async function importRoute(): Promise<CheckoutRouteModule> {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/stripeBilling', () => ({
        ActiveSubscriptionRequiresPortalError,
        CheckoutAlreadyInProgressError,
        ComplimentaryCheckoutNotAllowedError,
        createStripeCheckoutSession: createStripeCheckoutSessionMock,
    }));
    return import('@/app/api/stripe/checkout/route');
}

function post(body: unknown) {
    return createJsonRequest('http://localhost/api/stripe/checkout', body, {
        method: 'POST',
    });
}

describe('POST /api/stripe/checkout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        createStripeCheckoutSessionMock.mockResolvedValue({
            id: 'cs_test_1',
            url: 'https://checkout.stripe.test/session',
        });
    });

    it('requires auth', async () => {
        setMockUserId(null);
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PLUS' }));

        expect(response.status).toBe(401);
        expect(createStripeCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it('rejects invalid plans', async () => {
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'FREE' }));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid plan',
        });
        expect(createStripeCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it('creates a checkout session for a paid plan', async () => {
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PRO' }));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            id: 'cs_test_1',
            url: 'https://checkout.stripe.test/session',
        });
        expect(createStripeCheckoutSessionMock).toHaveBeenCalledWith({
            userId: 'user-1',
            email: null,
            plan: 'PRO',
        });
    });

    it('returns service unavailable when billing is not configured', async () => {
        createStripeCheckoutSessionMock.mockRejectedValue(
            new Error('STRIPE_SECRET_KEY is not configured')
        );
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PLUS' }));

        expect(response.status).toBe(503);
        await expect(readJson(response)).resolves.toEqual({
            error: 'STRIPE_SECRET_KEY is not configured',
        });
    });

    it('rejects checkout while complimentary Premium is active', async () => {
        createStripeCheckoutSessionMock.mockRejectedValue(
            new ComplimentaryCheckoutNotAllowedError(
                'Paid checkout is unavailable while complimentary Premium is active'
            )
        );
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PLUS' }));

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Paid checkout is unavailable while complimentary Premium is active',
        });
    });

    it('routes an existing paid subscription to the portal flow', async () => {
        createStripeCheckoutSessionMock.mockRejectedValue(
            new ActiveSubscriptionRequiresPortalError(
                'Manage the active paid subscription in the billing portal'
            )
        );
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PLUS' }));

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Manage the active paid subscription in the billing portal',
        });
    });
});
