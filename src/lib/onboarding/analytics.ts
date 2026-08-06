import { isRecord } from '@/lib/api/validation';

export const ONBOARDING_EVENT_NAMES = [
    'LANDING_VIEWED',
    'IDENTITY_SUBMITTED',
    'IDENTITY_LOOKUP_SUCCEEDED',
    'IDENTITY_LOOKUP_FAILED',
    'PERSONAL_ANALYSIS_STARTED',
    'PERSONAL_ANALYSIS_FAILED',
    'PERSONAL_ANALYSIS_MILESTONE',
    'PERSONAL_PUZZLE_READY',
    'MASTER_PUZZLE_SHOWN',
    'MASTER_ATTEMPT_STARTED',
    'MASTER_ATTEMPT_TERMINAL',
    'PERSONAL_READY_NOTICE_SHOWN',
    'PERSONAL_HANDOFF_CLICKED',
    'PERSONAL_PUZZLE_SHOWN',
    'PERSONAL_ATTEMPT_STARTED',
    'PERSONAL_ATTEMPT_TERMINAL',
    'SIGNUP_CLICKED',
    'SIGNUP_COMPLETED',
] as const;

export type OnboardingEventName = (typeof ONBOARDING_EVENT_NAMES)[number];

export type OnboardingAnalyticsEvent = {
    eventName: OnboardingEventName;
    sessionId: string;
    eventId: string;
    occurredAt: string;
    provider?: 'lichess' | 'chesscom';
    puzzleKind?: 'MASTER' | 'PERSONAL';
    experimentKey?: string;
    variantKey?: string;
    runId?: string;
    durationMs?: number;
    gameCount?: number;
    gameIndex?: number;
    progressMilestone?: 25 | 50 | 75 | 100;
    reason?: string;
    masterState?: 'SOLVING' | 'TERMINAL';
};

const ALLOWED_KEYS = new Set([
    'eventName',
    'sessionId',
    'eventId',
    'occurredAt',
    'provider',
    'puzzleKind',
    'experimentKey',
    'variantKey',
    'runId',
    'durationMs',
    'gameCount',
    'gameIndex',
    'progressMilestone',
    'reason',
    'masterState',
]);
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^[A-Za-z0-9:_-]{8,128}$/;
const BOUNDED_KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;

export function parseOnboardingAnalyticsEvent(
    value: unknown
): OnboardingAnalyticsEvent | null {
    if (!isRecord(value)) return null;
    if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return null;
    if (
        !ONBOARDING_EVENT_NAMES.includes(value.eventName as OnboardingEventName) ||
        typeof value.sessionId !== 'string' ||
        !UUID_RE.test(value.sessionId) ||
        typeof value.eventId !== 'string' ||
        !EVENT_ID_RE.test(value.eventId) ||
        typeof value.occurredAt !== 'string' ||
        Number.isNaN(new Date(value.occurredAt).getTime())
    ) {
        return null;
    }
    if (
        value.provider !== undefined &&
        value.provider !== 'lichess' &&
        value.provider !== 'chesscom'
    ) {
        return null;
    }
    if (
        value.runId !== undefined &&
        (typeof value.runId !== 'string' || !UUID_RE.test(value.runId))
    ) {
        return null;
    }
    const occurredAtMs = new Date(value.occurredAt as string).getTime();
    if (Math.abs(Date.now() - occurredAtMs) > MAX_EVENT_AGE_MS) return null;
    if (
        value.puzzleKind !== undefined &&
        value.puzzleKind !== 'MASTER' &&
        value.puzzleKind !== 'PERSONAL'
    ) {
        return null;
    }
    for (const key of ['experimentKey', 'variantKey'] as const) {
        const keyValue = value[key];
        if (
            keyValue !== undefined &&
            (typeof keyValue !== 'string' || !BOUNDED_KEY_RE.test(keyValue))
        ) {
            return null;
        }
    }
    for (const key of ['durationMs', 'gameCount', 'gameIndex'] as const) {
        const numberValue = value[key];
        if (
            numberValue !== undefined &&
            (!Number.isSafeInteger(numberValue) ||
                (numberValue as number) < 0 ||
                (numberValue as number) > 86_400_000)
        ) {
            return null;
        }
    }
    if (
        value.progressMilestone !== undefined &&
        value.progressMilestone !== 25 &&
        value.progressMilestone !== 50 &&
        value.progressMilestone !== 75 &&
        value.progressMilestone !== 100
    ) {
        return null;
    }
    if (
        value.reason !== undefined &&
        (typeof value.reason !== 'string' || value.reason.length > 64)
    ) {
        return null;
    }
    if (
        value.masterState !== undefined &&
        value.masterState !== 'SOLVING' &&
        value.masterState !== 'TERMINAL'
    ) {
        return null;
    }
    return value as OnboardingAnalyticsEvent;
}
