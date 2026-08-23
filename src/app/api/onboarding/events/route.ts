import { NextResponse } from 'next/server';

import { boundedJsonBody } from '@/lib/api/validation';
import { parseOnboardingAnalyticsEvent } from '@/lib/onboarding/analytics';
import { recordOnboardingAnalyticsEvent } from '@/lib/onboarding/analyticsPersistence';
import {
    consumeOnboardingRateLimit,
    onboardingRequestKeyHash,
} from '@/lib/onboarding/rateLimit';
import {
    measureRequestPhase,
    withRequestTrace,
} from '@/lib/performance/requestTrace';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request) {
    return withRequestTrace(
        { route: '/api/onboarding/events', request },
        () => recordEvent(request)
    );
}

async function recordEvent(request: Request) {
    const networkLimit = await measureRequestPhase('network_limit', () =>
        consumeOnboardingRateLimit({
            keyHash: onboardingRequestKeyHash(
                request,
                'onboarding-events-network'
            ),
            namespace: 'onboarding-events-network',
            limit: 240,
        })
    );
    if (!networkLimit.allowed) {
        return NextResponse.json(
            { accepted: false, rateLimited: true },
            {
                status: 429,
                headers: {
                    'Retry-After': String(networkLimit.retryAfterSeconds),
                    'Cache-Control': 'private, no-store',
                },
            }
        );
    }
    const body = await measureRequestPhase('parse', () =>
        boundedJsonBody(request, MAX_BODY_BYTES)
    );
    const event = body.ok ? parseOnboardingAnalyticsEvent(body.value) : null;
    if (!event) {
        return NextResponse.json(
            { accepted: false, error: 'Invalid onboarding event.' },
            {
                status: body.ok ? 400 : (body.status ?? 400),
                headers: { 'Cache-Control': 'private, no-store' },
            }
        );
    }

    const result = await measureRequestPhase('persist', () =>
        recordOnboardingAnalyticsEvent(event)
    );
    if (result.rateLimited) {
        return NextResponse.json(
            { accepted: false, rateLimited: true },
            {
                status: 429,
                headers: {
                    'Retry-After': String(result.retryAfterSeconds),
                    'Cache-Control': 'private, no-store',
                },
            }
        );
    }
    return NextResponse.json(
        { accepted: true, duplicate: result.duplicate },
        {
            status: 202,
            headers: { 'Cache-Control': 'private, no-store' },
        }
    );
}
