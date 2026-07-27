import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

type PortalRouteModule = typeof import('@/app/api/stripe/portal/route');

const createStripePortalSessionMock = vi.fn();

async function importRoute(): Promise<PortalRouteModule> {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/stripeBilling', () => ({
        createStripePortalSession: createStripePortalSessionMock,
    }));
    return import('@/app/api/stripe/portal/route');
}

describe('POST /api/stripe/portal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        createStripePortalSessionMock.mockResolvedValue({
            id: 'bps_test_1',
            url: 'https://billing.stripe.test/session',
        });
    });

    it('requires auth', async () => {
        setMockUserId(null);
        const route = await importRoute();

        const response = await route.POST();

        expect(response.status).toBe(401);
        expect(createStripePortalSessionMock).not.toHaveBeenCalled();
    });

    it('creates a portal session for the current user', async () => {
        const route = await importRoute();

        const response = await route.POST();

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            id: 'bps_test_1',
            url: 'https://billing.stripe.test/session',
        });
        expect(createStripePortalSessionMock).toHaveBeenCalledWith('user-1');
    });

    it('returns service unavailable when Stripe is not configured', async () => {
        createStripePortalSessionMock.mockRejectedValue(
            new Error('STRIPE_SECRET_KEY is not configured')
        );
        const route = await importRoute();

        const response = await route.POST();

        expect(response.status).toBe(503);
        await expect(readJson(response)).resolves.toEqual({
            error: 'STRIPE_SECRET_KEY is not configured',
        });
    });
});
