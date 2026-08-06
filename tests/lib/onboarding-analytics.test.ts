import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseOnboardingAnalyticsEvent } from '@/lib/onboarding/analytics';
import { recordOnboardingAnalyticsEvent } from '@/lib/onboarding/analyticsPersistence';
import { consumeOnboardingRateLimit } from '@/lib/onboarding/rateLimit';

const now = new Date('2026-08-06T12:00:00.000Z');
const sessionId = '10000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000002';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('onboarding analytics boundary', () => {
    it('accepts a bounded event and rejects identity-bearing extra data', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        expect(
            parseOnboardingAnalyticsEvent({
                eventName: 'PERSONAL_PUZZLE_READY',
                sessionId,
                eventId: '10000000-0000-4000-8000-000000000003',
                runId,
                provider: 'lichess',
                occurredAt: now.toISOString(),
                durationMs: 12_000,
            })
        ).not.toBeNull();
        expect(
            parseOnboardingAnalyticsEvent({
                eventName: 'PERSONAL_PUZZLE_READY',
                sessionId,
                eventId: '10000000-0000-4000-8000-000000000003',
                runId,
                provider: 'lichess',
                occurredAt: now.toISOString(),
                username: 'must-not-be-recorded',
            })
        ).toBeNull();
    });

    it('requires UUID session/run IDs and a timestamp within 24 hours', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const base = {
            eventName: 'IDENTITY_SUBMITTED',
            sessionId,
            eventId: '10000000-0000-4000-8000-000000000003',
            occurredAt: now.toISOString(),
        };
        expect(
            parseOnboardingAnalyticsEvent({ ...base, sessionId: 'session-1' })
        ).toBeNull();
        expect(
            parseOnboardingAnalyticsEvent({ ...base, runId: 'run-1' })
        ).toBeNull();
        expect(
            parseOnboardingAnalyticsEvent({
                ...base,
                occurredAt: new Date(now.getTime() - 86_400_001).toISOString(),
            })
        ).toBeNull();
    });

    it('claims the persistent bucket atomically and reports saturation', async () => {
        const allowed = await consumeOnboardingRateLimit({
            keyHash: 'a'.repeat(64),
            namespace: 'onboarding-games',
            limit: 8,
            now,
            db: { $queryRaw: vi.fn().mockResolvedValue([{ requestCount: 1 }]) } as never,
        });
        const blocked = await consumeOnboardingRateLimit({
            keyHash: 'a'.repeat(64),
            namespace: 'onboarding-games',
            limit: 8,
            now,
            db: { $queryRaw: vi.fn().mockResolvedValue([]) } as never,
        });
        expect(allowed.allowed).toBe(true);
        expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    });

    it('persists the allowlisted event in the same transaction as its bucket claim', async () => {
        vi.stubEnv('ONBOARDING_RATE_LIMIT_SECRET', 'test-secret');
        const create = vi.fn().mockResolvedValue({ id: 'stored' });
        const queryRaw = vi.fn().mockResolvedValue([{ requestCount: 1 }]);
        const transaction = vi.fn(async (callback) =>
            callback({
                $queryRaw: queryRaw,
                onboardingAnalyticsEvent: { create },
            })
        );
        const event = {
            eventName: 'IDENTITY_SUBMITTED' as const,
            sessionId,
            eventId: '10000000-0000-4000-8000-000000000003',
            runId,
            provider: 'lichess' as const,
            occurredAt: now.toISOString(),
        };

        const result = await recordOnboardingAnalyticsEvent(event, {
            $transaction: transaction,
        } as never);

        expect(result.recorded).toBe(true);
        expect(queryRaw).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                sessionId,
                eventId: event.eventId,
                onboardingRunId: runId,
                eventName: 'IDENTITY_SUBMITTED',
                provider: 'LICHESS',
            }),
        });
    });
});
