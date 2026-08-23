import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';

import type { OnboardingAnalyticsEvent } from './analytics';
import {
    onboardingSessionKeyHash,
} from './rateLimit';

type AnalyticsPersistenceDb = Pick<PrismaClient, '$queryRaw'>;

export async function recordOnboardingAnalyticsEvent(
    event: OnboardingAnalyticsEvent,
    db: AnalyticsPersistenceDb = prisma
) {
    const now = new Date();
    const windowMs = 60_000;
    const windowStartedAt = new Date(
        Math.floor(now.getTime() / windowMs) * windowMs
    );
    const provider =
        event.provider === 'lichess'
            ? 'LICHESS'
            : event.provider === 'chesscom'
              ? 'CHESSCOM'
              : null;
    const rows = await db.$queryRaw<
        Array<{ allowed: boolean; inserted: boolean }>
    >(Prisma.sql`
        WITH "claimed" AS (
            INSERT INTO "OnboardingRateBucket"
                ("keyHash", "namespace", "windowStartedAt", "requestCount", "updatedAt")
            VALUES
                (${onboardingSessionKeyHash(event.sessionId, 'onboarding-events')}, 'onboarding-events', ${windowStartedAt}, 1, ${now})
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
                OR "OnboardingRateBucket"."requestCount" < 60
            RETURNING 1
        ),
        "inserted" AS (
            INSERT INTO "OnboardingAnalyticsEvent" (
                "id", "sessionId", "eventId", "onboardingRunId", "eventName",
                "provider", "puzzleKind", "experimentKey", "variantKey",
                "durationMs", "gameCount", "gameIndex", "progressMilestone",
                "reason", "masterState", "occurredAt", "recordedAt"
            )
            SELECT
                ${randomUUID()}::uuid,
                ${event.sessionId}::uuid,
                ${event.eventId},
                ${event.runId ?? null}::uuid,
                ${event.eventName}::"OnboardingEventName",
                ${provider}::"SyncProvider",
                ${event.puzzleKind ?? null}::"OnboardingPuzzleKind",
                ${event.experimentKey ?? null},
                ${event.variantKey ?? null},
                ${event.durationMs ?? null},
                ${event.gameCount ?? null},
                ${event.gameIndex ?? null},
                ${event.progressMilestone ?? null},
                ${event.reason ?? null},
                ${event.masterState ?? null}::"OnboardingMasterState",
                ${new Date(event.occurredAt)},
                ${now}
            FROM "claimed"
            ON CONFLICT ("sessionId", "eventId") DO NOTHING
            RETURNING 1
        )
        SELECT
            EXISTS (SELECT 1 FROM "claimed") AS "allowed",
            EXISTS (SELECT 1 FROM "inserted") AS "inserted"
    `);
    const row = rows[0] ?? { allowed: false, inserted: false };
    if (!row.allowed) {
        return {
            recorded: false,
            duplicate: false,
            rateLimited: true,
            retryAfterSeconds: Math.max(
                1,
                Math.ceil(
                    (windowStartedAt.getTime() + windowMs - now.getTime()) /
                        1_000
                )
            ),
        } as const;
    }
    return {
        recorded: true,
        duplicate: !row.inserted,
        rateLimited: false,
        retryAfterSeconds: 0,
    } as const;
}
