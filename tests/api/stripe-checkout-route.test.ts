import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { createJsonRequest, readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

type CheckoutRouteModule = typeof import('@/app/api/stripe/checkout/route');

const createStripeCheckoutSessionMock = vi.fn();
class ComplimentaryCheckoutNotAllowedError extends Error {}
class ExistingSubscriptionRequiresPortalError extends Error {}
class CheckoutAlreadyInProgressError extends Error {}

async function importRoute(): Promise<CheckoutRouteModule> {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/stripeBilling', () => ({
        CheckoutAlreadyInProgressError,
        ComplimentaryCheckoutNotAllowedError,
        ExistingSubscriptionRequiresPortalError,
        createStripeCheckoutSession: createStripeCheckoutSessionMock,
    }));
    return import('@/app/api/stripe/checkout/route');
}

function post(body: unknown, ownerId: string | null = 'user-1') {
    const headers = new Headers();
    if (ownerId !== null) headers.set(EXPECTED_OWNER_HEADER, ownerId);
    return createJsonRequest('http://localhost/api/stripe/checkout', body, {
        method: 'POST',
        headers,
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
            code: 'INVALID_CHECKOUT_REQUEST',
        });
        expect(createStripeCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it.each([null, 'stale-user'])(
        'rejects missing or stale render owner %s before parsing or Stripe calls',
        async (ownerId) => {
            const route = await importRoute();
            const headers = new Headers();
            if (ownerId !== null) {
                headers.set(EXPECTED_OWNER_HEADER, ownerId);
            }

            const response = await route.POST(
                new Request('http://localhost/api/stripe/checkout', {
                    method: 'POST',
                    headers,
                    body: 'not-json',
                })
            );

            expect(response.status).toBe(409);
            await expect(readJson(response)).resolves.toMatchObject({
                code: 'OWNER_MISMATCH',
            });
            expect(createStripeCheckoutSessionMock).not.toHaveBeenCalled();
        }
    );

    it('rejects unexpected checkout fields', async () => {
        const route = await importRoute();

        const response = await route.POST(
            post({ plan: 'PLUS', userId: 'another-user' })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'INVALID_CHECKOUT_REQUEST',
        });
        expect(createStripeCheckoutSessionMock).not.toHaveBeenCalled();
    });

    it('creates a checkout session for a paid plan', async () => {
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PRO' }));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            ownerId: 'user-1',
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
            new ExistingSubscriptionRequiresPortalError(
                'Manage the existing paid subscription in the billing portal'
            )
        );
        const route = await importRoute();

        const response = await route.POST(post({ plan: 'PLUS' }));

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Manage the existing paid subscription in the billing portal',
        });
    });
});
