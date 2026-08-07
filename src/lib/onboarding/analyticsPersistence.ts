import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';

import type { OnboardingAnalyticsEvent } from './analytics';
import {
    consumeOnboardingRateLimit,
    onboardingSessionKeyHash,
} from './rateLimit';

type AnalyticsPersistenceDb = Pick<PrismaClient, '$transaction'>;

export async function recordOnboardingAnalyticsEvent(
    event: OnboardingAnalyticsEvent,
    db: AnalyticsPersistenceDb = prisma
) {
    try {
        return await db.$transaction(async (tx) => {
            const rateLimit = await consumeOnboardingRateLimit({
                keyHash: onboardingSessionKeyHash(
                    event.sessionId,
                    'onboarding-events'
                ),
                namespace: 'onboarding-events',
                limit: 60,
                db: tx,
            });
            if (!rateLimit.allowed) {
                return {
                    recorded: false,
                    duplicate: false,
                    rateLimited: true,
                    retryAfterSeconds: rateLimit.retryAfterSeconds,
                } as const;
            }
            await tx.onboardingAnalyticsEvent.create({
                data: {
                    sessionId: event.sessionId,
                    eventId: event.eventId,
                    onboardingRunId: event.runId ?? null,
                    eventName: event.eventName,
                    provider:
                        event.provider === 'lichess'
                            ? 'LICHESS'
                            : event.provider === 'chesscom'
                              ? 'CHESSCOM'
                              : null,
                    puzzleKind: event.puzzleKind ?? null,
                    experimentKey: event.experimentKey ?? null,
                    variantKey: event.variantKey ?? null,
                    durationMs: event.durationMs ?? null,
                    gameCount: event.gameCount ?? null,
                    gameIndex: event.gameIndex ?? null,
                    progressMilestone: event.progressMilestone ?? null,
                    reason: event.reason ?? null,
                    masterState: event.masterState ?? null,
                    occurredAt: new Date(event.occurredAt),
                },
            });
            return {
                recorded: true,
                duplicate: false,
                rateLimited: false,
                retryAfterSeconds: 0,
            } as const;
        });
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            return {
                recorded: true,
                duplicate: true,
                rateLimited: false,
                retryAfterSeconds: 0,
            } as const;
        }
        throw error;
    }
}
