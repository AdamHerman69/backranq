import { beforeEach, describe, expect, it, vi } from 'vitest';

import { consumeProviderProxyRateLimit } from '@/lib/api/providerProxyRateLimit';
import {
    consumeOnboardingRateLimit,
    onboardingRequestKeyHash,
    onboardingSessionKeyHash,
} from '@/lib/onboarding/rateLimit';

vi.mock('@/lib/onboarding/rateLimit', () => ({
    consumeOnboardingRateLimit: vi.fn(),
    onboardingRequestKeyHash: vi.fn(() => 'network-hash'),
    onboardingSessionKeyHash: vi.fn(() => 'owner-hash'),
}));

const consumeMock = vi.mocked(consumeOnboardingRateLimit);

describe('provider proxy rate limiting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        consumeMock.mockResolvedValue({
            allowed: true,
            retryAfterSeconds: 0,
        });
    });

    it('claims both the network and signed-in owner buckets', async () => {
        const request = new Request('http://localhost/api/lichess/games', {
            headers: { 'x-forwarded-for': '203.0.113.9' },
        });

        await expect(
            consumeProviderProxyRateLimit({
                request,
                userId: 'user-1',
                operation: 'games',
            })
        ).resolves.toEqual({ allowed: true });

        expect(onboardingRequestKeyHash).toHaveBeenCalledWith(
            request,
            'provider-proxy:games:network'
        );
        expect(onboardingSessionKeyHash).toHaveBeenCalledWith(
            'user-1',
            'provider-proxy:games:owner'
        );
        expect(consumeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                namespace: 'provider-proxy:games:owner',
                limit: 30,
            })
        );
        expect(consumeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                namespace: 'provider-proxy:games:network',
                limit: 120,
            })
        );
    });

    it('stops before consuming the shared network bucket when the owner is limited', async () => {
        consumeMock.mockResolvedValueOnce({
            allowed: false,
            retryAfterSeconds: 19,
        });

        await expect(
            consumeProviderProxyRateLimit({
                request: new Request('http://localhost'),
                userId: 'user-1',
                operation: 'profile',
            })
        ).resolves.toEqual({
            allowed: false,
            retryAfterSeconds: 19,
        });
        expect(consumeMock).toHaveBeenCalledOnce();
        expect(onboardingRequestKeyHash).not.toHaveBeenCalled();
    });
});
