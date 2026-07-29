import { Prisma, type PrismaClient } from '@prisma/client';

export const PROGRESS_INSIGHT_KEYS = [
    'coverage',
    'first-outcome',
    'practice-performance',
    'review-retention',
    'game-phase',
    'impact',
    'source-provider-time-control',
] as const;

export const PROGRESS_ACTION_KEYS = [
    'primary-next-action',
    'practice-position',
    'games-coverage',
    'clear-filters',
    'scope-28',
    'scope-90',
    'scope-all',
    'provider-filter',
    'time-class-filter',
] as const;

export const PROGRESS_RECOMMENDATION_KEYS = [
    'mixed-practice',
    'review-position',
    'analyze-games',
    'connect-account',
    'show-all-progress',
    'show-all-time',
    'view-games',
] as const;

const EVENT_NAMES = [
    'PROGRESS_VIEWED',
    'INSIGHT_EXPANDED',
    'ACTION_CLICKED',
    'PRACTICE_STARTED_FROM_PROGRESS',
] as const;
const PROVIDERS = ['LICHESS', 'CHESSCOM'] as const;
const TIME_CLASSES = [
    'BULLET',
    'BLITZ',
    'RAPID',
    'CLASSICAL',
    'UNKNOWN',
] as const;
const WINDOWS = [28, 90] as const;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_PAST_SKEW_MS = 7 * 24 * 60 * 60_000;
export const MAX_PROGRESS_EVENTS_PER_MINUTE = 60;

type ProgressInsightKey = (typeof PROGRESS_INSIGHT_KEYS)[number];
type ProgressActionKey = (typeof PROGRESS_ACTION_KEYS)[number];
type ProgressRecommendationKey =
    (typeof PROGRESS_RECOMMENDATION_KEYS)[number];
type ProgressProvider = (typeof PROVIDERS)[number];
type ProgressTimeClass = (typeof TIME_CLASSES)[number];
type ProgressWindowDays = (typeof WINDOWS)[number];

type CommonEvent = {
    clientEventId: string;
    occurredAt: string;
    windowDays?: ProgressWindowDays;
    provider?: ProgressProvider;
    timeClass?: ProgressTimeClass;
};

export type ProgressAnalyticsWrite =
    | (CommonEvent & {
          eventName: 'PROGRESS_VIEWED';
      })
    | (CommonEvent & {
          eventName: 'INSIGHT_EXPANDED';
          insightKey: ProgressInsightKey;
      })
    | (CommonEvent & {
          eventName: 'ACTION_CLICKED';
          actionKey: ProgressActionKey;
          recommendationKey?: ProgressRecommendationKey;
      })
    | (CommonEvent & {
          eventName: 'PRACTICE_STARTED_FROM_PROGRESS';
          recommendationKey?: ProgressRecommendationKey;
      });

type AnalyticsDb = Pick<
    PrismaClient,
    'progressAnalyticsEvent' | '$queryRaw'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function oneOf<T extends readonly unknown[]>(
    values: T,
    value: unknown
): value is T[number] {
    return values.includes(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[]
) {
    return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseProgressAnalyticsWrite(
    value: unknown,
    now = new Date()
): ProgressAnalyticsWrite | null {
    if (!isRecord(value) || !oneOf(EVENT_NAMES, value.eventName)) {
        return null;
    }
    if (
        typeof value.clientEventId !== 'string' ||
        !UUID_RE.test(value.clientEventId) ||
        typeof value.occurredAt !== 'string'
    ) {
        return null;
    }
    const occurredAt = new Date(value.occurredAt);
    if (
        Number.isNaN(occurredAt.getTime()) ||
        occurredAt.toISOString() !== value.occurredAt ||
        occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS ||
        occurredAt.getTime() < now.getTime() - MAX_PAST_SKEW_MS
    ) {
        return null;
    }
    if (
        value.windowDays != null &&
        !oneOf(WINDOWS, value.windowDays)
    ) {
        return null;
    }
    if (
        value.provider != null &&
        !oneOf(PROVIDERS, value.provider)
    ) {
        return null;
    }
    if (
        value.timeClass != null &&
        !oneOf(TIME_CLASSES, value.timeClass)
    ) {
        return null;
    }

    const common = [
        'eventName',
        'clientEventId',
        'occurredAt',
        'windowDays',
        'provider',
        'timeClass',
    ];
    if (value.eventName === 'PROGRESS_VIEWED') {
        return hasOnlyKeys(value, common)
            ? (value as ProgressAnalyticsWrite)
            : null;
    }
    if (value.eventName === 'INSIGHT_EXPANDED') {
        return hasOnlyKeys(value, [...common, 'insightKey']) &&
            oneOf(PROGRESS_INSIGHT_KEYS, value.insightKey)
            ? (value as ProgressAnalyticsWrite)
            : null;
    }
    if (value.eventName === 'ACTION_CLICKED') {
        return hasOnlyKeys(value, [
            ...common,
            'actionKey',
            'recommendationKey',
        ]) &&
            oneOf(PROGRESS_ACTION_KEYS, value.actionKey) &&
            (value.recommendationKey == null ||
                oneOf(
                    PROGRESS_RECOMMENDATION_KEYS,
                    value.recommendationKey
                ))
            ? (value as ProgressAnalyticsWrite)
            : null;
    }
    return hasOnlyKeys(value, [
        ...common,
        'recommendationKey',
    ]) &&
        (value.recommendationKey == null ||
            oneOf(
                PROGRESS_RECOMMENDATION_KEYS,
                value.recommendationKey
            ))
        ? (value as ProgressAnalyticsWrite)
        : null;
}

export async function recordProgressAnalyticsEvent(args: {
    db: AnalyticsDb;
    userId: string;
    event: ProgressAnalyticsWrite;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const windowStartedAt = new Date(
        Math.floor(now.getTime() / 60_000) * 60_000
    );
    const claimed = await args.db.$queryRaw<
        Array<{ eventCount: number }>
    >(Prisma.sql`
        INSERT INTO "ProgressAnalyticsRateBucket"
            ("userId", "windowStartedAt", "eventCount", "updatedAt")
        VALUES
            (${args.userId}::uuid, ${windowStartedAt}, 1, ${now})
        ON CONFLICT ("userId") DO UPDATE
        SET
            "windowStartedAt" = CASE
                WHEN "ProgressAnalyticsRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
                THEN EXCLUDED."windowStartedAt"
                ELSE "ProgressAnalyticsRateBucket"."windowStartedAt"
            END,
            "eventCount" = CASE
                WHEN "ProgressAnalyticsRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
                THEN 1
                ELSE "ProgressAnalyticsRateBucket"."eventCount" + 1
            END,
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE
            "ProgressAnalyticsRateBucket"."windowStartedAt" < EXCLUDED."windowStartedAt"
            OR "ProgressAnalyticsRateBucket"."eventCount" < ${MAX_PROGRESS_EVENTS_PER_MINUTE}
        RETURNING "eventCount"
    `);
    if (claimed.length === 0) {
        return {
            recorded: false,
            duplicate: false,
            rateLimited: true,
        } as const;
    }

    try {
        await args.db.progressAnalyticsEvent.create({
            data: {
                userId: args.userId,
                clientEventId: args.event.clientEventId,
                eventName: args.event.eventName,
                occurredAt: new Date(args.event.occurredAt),
                windowDays: args.event.windowDays ?? null,
                provider: args.event.provider ?? null,
                timeClass: args.event.timeClass ?? null,
                insightKey:
                    args.event.eventName === 'INSIGHT_EXPANDED'
                        ? args.event.insightKey
                        : null,
                actionKey:
                    args.event.eventName === 'ACTION_CLICKED'
                        ? args.event.actionKey
                        : null,
                recommendationKey:
                    args.event.eventName === 'ACTION_CLICKED' ||
                    args.event.eventName ===
                        'PRACTICE_STARTED_FROM_PROGRESS'
                        ? args.event.recommendationKey ?? null
                        : null,
            },
        });
        return {
            recorded: true,
            duplicate: false,
            rateLimited: false,
        } as const;
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            return {
                recorded: true,
                duplicate: true,
                rateLimited: false,
            } as const;
        }
        throw error;
    }
}
