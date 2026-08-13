import {
    consumeOnboardingRateLimit,
    onboardingRequestKeyHash,
    onboardingSessionKeyHash,
} from '@/lib/onboarding/rateLimit';

export type ProviderProxyRateLimitResult =
    | { allowed: true }
    | { allowed: false; retryAfterSeconds: number };

/**
 * Provider credentials and upstream quotas are shared infrastructure. Apply a
 * distributed limit to both the signed-in owner and the request network so a
 * throwaway account cannot bypass protection for the whole deployment.
 */
export async function consumeProviderProxyRateLimit(args: {
    request: Request;
    userId: string;
    operation: 'games' | 'profile';
}): Promise<ProviderProxyRateLimitResult> {
    const perUserLimit = args.operation === 'games' ? 30 : 60;
    const perNetworkLimit = args.operation === 'games' ? 120 : 180;
    const namespace = `provider-proxy:${args.operation}`;
    const owner = await consumeOnboardingRateLimit({
        keyHash: onboardingSessionKeyHash(
            args.userId,
            `${namespace}:owner`
        ),
        namespace: `${namespace}:owner`,
        limit: perUserLimit,
    });
    if (!owner.allowed) return owner;

    const network = await consumeOnboardingRateLimit({
        keyHash: onboardingRequestKeyHash(
            args.request,
            `${namespace}:network`
        ),
        namespace: `${namespace}:network`,
        limit: perNetworkLimit,
    });
    return network.allowed ? { allowed: true } : network;
}
