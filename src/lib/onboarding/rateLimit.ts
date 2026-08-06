import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';

type RateLimitDb = Pick<PrismaClient, '$queryRaw'>;

function rateLimitSecret() {
    const secret =
        process.env.ONBOARDING_RATE_LIMIT_SECRET ??
        process.env.AUTH_SECRET ??
        process.env.NEXTAUTH_SECRET;
    if (secret) return secret;
    if (process.env.NODE_ENV !== 'production') {
        return 'backranq-local-onboarding-rate-limit';
    }
    throw new Error('Onboarding rate-limit secret is not configured.');
}

function hmacKey(namespace: string, value: string) {
    return createHmac('sha256', rateLimitSecret())
        .update(`${namespace}\0${value}`)
        .digest('hex');
}

function requestNetworkIdentifier(request: Request): string {
    return (
        request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip')?.trim() ||
        'unknown'
    ).slice(0, 128);
}

export function onboardingRequestKeyHash(
    request: Request,
    namespace: string
) {
    return hmacKey(namespace, requestNetworkIdentifier(request));
}

export function onboardingSessionKeyHash(sessionId: string, namespace: string) {
    return hmacKey(namespace, sessionId);
}

export async function consumeOnboardingRateLimit(args: {
    keyHash: string;
    namespace: string;
    limit: number;
    windowMs?: number;
    now?: Date;
    db?: RateLimitDb;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const db = args.db ?? prisma;
    const now = args.now ?? new Date();
    const windowMs = args.windowMs ?? 60_000;
    const windowStartedAt = new Date(
        Math.floor(now.getTime() / windowMs) * windowMs
    );
    const claimed = await db.$queryRaw<Array<{ requestCount: number }>>(
        Prisma.sql`
            INSERT INTO "OnboardingRateBucket"
                ("keyHash", "namespace", "windowStartedAt", "requestCount", "updatedAt")
            VALUES
                (${args.keyHash}, ${args.namespace}, ${windowStartedAt}, 1, ${now})
            ON CONFLICT ("keyHash", "namespace") DO UPDATE
            SET
                "windowStartedAt" = CASE
                    WHEN "OnboardingRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
                    THEN EXCLUDED."windowStartedAt"
                    ELSE "OnboardingRateBucket"."windowStartedAt"
                END,
                "requestCount" = CASE
                    WHEN "OnboardingRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
                    THEN 1
                    ELSE "OnboardingRateBucket"."requestCount" + 1
                END,
                "updatedAt" = EXCLUDED."updatedAt"
            WHERE
                "OnboardingRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
                OR "OnboardingRateBucket"."requestCount" < ${args.limit}
            RETURNING "requestCount"
        `
    );
    return claimed.length > 0
        ? { allowed: true, retryAfterSeconds: 0 }
        : {
              allowed: false,
              retryAfterSeconds: Math.max(
                  1,
                  Math.ceil(
                      (windowStartedAt.getTime() + windowMs - now.getTime()) /
                          1_000
                  )
              ),
          };
}
