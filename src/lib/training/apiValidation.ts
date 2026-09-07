import type { RecordTrainingAttemptRequest, EnrichTrainingAttemptRequest } from './attemptApi';
import {
    TRAINING_API_MAX_ID_LENGTH,
    PRACTICE_FEED_MAX_LIMIT,
    PRACTICE_FEED_FOCUSES,
    PRACTICE_FEED_MODES,
    type PracticeFeedFocus,
    type PracticeFeedRequest,
    type TrainingPhase,
} from '@/lib/training/api';
import {
    TRAINING_LESSON_KINDS,
    TRAINING_SOURCE_KINDS,
    type TrainingLessonKind,
    type TrainingSourceKind,
} from '@/lib/training/contracts';
import { parseTrainingCompletionTime } from '@/lib/training/completionTime';

export const MAX_TRAINING_API_BODY_BYTES = 65_536;
// Attempt enrichment may carry several bounded searches with full game history.
export const MAX_TRAINING_ATTEMPT_BODY_BYTES = 1_048_576;
export const MAX_TRAINING_ATTEMPT_TIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_TRAINING_CONTINUATION_STEPS = 64;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const PHASES = ['OPENING', 'MIDDLEGAME', 'ENDGAME'] as const;
const FEED_QUERY_KEYS = new Set([
    'limit',
    'cursor',
    'focus',
    'phase',
    'sourceKind',
    'lessonKind',
    'theme',
    'minConfidence',
    'mode',
    'gameId',
]);

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

export function isTrainingApiUuid(value: string): boolean {
    return value.length <= TRAINING_API_MAX_ID_LENGTH && UUID_RE.test(value);
}

function boundedUniqueEnum<T extends string>(
    values: string[],
    allowed: readonly T[],
    max: number
): T[] | null {
    if (values.length > max) return null;
    const normalized = Array.from(
        new Set(values.map((value) => value.trim().toUpperCase()))
    );
    if (
        normalized.some(
            (value) => !(allowed as readonly string[]).includes(value)
        )
    ) {
        return null;
    }
    return normalized as T[];
}

function boundedThemes(values: string[]): string[] | null {
    if (values.length > 32) return null;
    const themes = Array.from(
        new Set(values.map((value) => value.trim().toLowerCase()))
    );
    if (
        themes.some(
            (theme) =>
                !theme ||
                theme.length > 64 ||
                !/^[a-z0-9][a-z0-9_-]*$/.test(theme)
        )
    ) {
        return null;
    }
    return themes;
}

export function parsePracticeFeedRequest(
    url: URL
): PracticeFeedRequest | null {
    if (
        Array.from(url.searchParams.keys()).some(
            (key) => !FEED_QUERY_KEYS.has(key)
        ) ||
        [
            'limit',
            'cursor',
            'focus',
            'minConfidence',
            'mode',
            'gameId',
        ].some(
            (key) => url.searchParams.getAll(key).length > 1
        )
    ) {
        return null;
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit == null ? 10 : Number(rawLimit);
    if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > PRACTICE_FEED_MAX_LIMIT
    ) {
        return null;
    }
    const cursor = url.searchParams.get('cursor')?.trim() || undefined;
    if (cursor && cursor.length > 1_024) return null;
    const rawFocus = url.searchParams.get('focus');
    const focus =
        rawFocus == null
            ? undefined
            : rawFocus.trim().toUpperCase();
    if (
        focus !== undefined &&
        !(PRACTICE_FEED_FOCUSES as readonly string[]).includes(
            focus
        )
    ) {
        return null;
    }

    const phases = boundedUniqueEnum(
        url.searchParams.getAll('phase'),
        PHASES,
        PHASES.length
    );
    const sourceKinds = boundedUniqueEnum(
        url.searchParams.getAll('sourceKind'),
        TRAINING_SOURCE_KINDS,
        TRAINING_SOURCE_KINDS.length
    );
    const lessonKinds = boundedUniqueEnum(
        url.searchParams.getAll('lessonKind'),
        TRAINING_LESSON_KINDS,
        TRAINING_LESSON_KINDS.length
    );
    const themes = boundedThemes(url.searchParams.getAll('theme'));
    if (!phases || !sourceKinds || !lessonKinds || !themes) return null;

    const rawConfidence = url.searchParams.get('minConfidence');
    const minConfidence =
        rawConfidence == null ? undefined : Number(rawConfidence);
    if (
        minConfidence !== undefined &&
        (!Number.isFinite(minConfidence) ||
            minConfidence < 0 ||
            minConfidence > 1)
    ) {
        return null;
    }
    const rawMode = url.searchParams.get('mode');
    const mode = rawMode == null ? undefined : rawMode.trim().toUpperCase();
    if (
        mode !== undefined &&
        !(PRACTICE_FEED_MODES as readonly string[]).includes(mode)
    ) {
        return null;
    }
    const gameId = url.searchParams.get('gameId')?.trim() || undefined;
    if (gameId && !isTrainingApiUuid(gameId)) return null;

    return {
        limit,
        ...(cursor ? { cursor } : {}),
        filters: {
            ...(focus !== undefined
                ? {
                      focus: focus as PracticeFeedFocus,
                  }
                : {}),
            ...(phases.length > 0
                ? { phases: phases as TrainingPhase[] }
                : {}),
            ...(sourceKinds.length > 0
                ? {
                      sourceKinds:
                          sourceKinds as TrainingSourceKind[],
                  }
                : {}),
            ...(lessonKinds.length > 0
                ? {
                      lessonKinds:
                          lessonKinds as TrainingLessonKind[],
                  }
                : {}),
            ...(themes.length > 0 ? { themes } : {}),
            ...(minConfidence !== undefined ? { minConfidence } : {}),
            ...(mode !== undefined
                ? {
                      mode: mode as NonNullable<
                          PracticeFeedRequest['filters']
                      >['mode'],
                  }
                : {}),
            ...(gameId ? { gameId } : {}),
        },
    };
}

function parseTimeSpentMs(value: unknown): number | null | 'INVALID' {
    if (value === undefined) return null;
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_TRAINING_ATTEMPT_TIME_MS
    ) {
        return 'INVALID';
    }
    return value;
}

function boundedId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function eventIdentity(value: Record<string, unknown>): boolean {
    return typeof value.clientAttemptId === 'string' && isTrainingApiUuid(value.clientAttemptId) &&
        typeof value.momentRevisionId === 'string' && isTrainingApiUuid(value.momentRevisionId);
}
function stepIndex(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TRAINING_CONTINUATION_STEPS;
}
export function parseRecordTrainingAttemptRequest(value: unknown, receivedAt = new Date()): RecordTrainingAttemptRequest | null {
    if (!isObject(value) || !eventIdentity(value)) return null;
    if (value.kind === 'REVEAL') {
        if (!hasOnlyKeys(value, ['kind', 'clientAttemptId', 'momentRevisionId', 'revealedAt'])) return null;
        const at = parseTrainingCompletionTime(value.revealedAt, receivedAt);
        return at ? { ...value, revealedAt: at.toISOString() } as RecordTrainingAttemptRequest : null;
    }
    if (value.kind !== 'RECORD' || !hasOnlyKeys(value, ['kind', 'clientAttemptId', 'momentRevisionId', 'stepIndex', 'contextId', 'moveUci', 'playedAt', 'timeSpentMs', 'initialAssessmentId', 'initialCoverageGroupId', 'resolution']) ||
        !stepIndex(value.stepIndex) || !boundedId(value.contextId) || typeof value.moveUci !== 'string' || !UCI_RE.test(value.moveUci) ||
        !['PENDING','RESOLVED','UNAVAILABLE'].includes(String(value.resolution)) ||
        (value.initialAssessmentId !== null && !boundedId(value.initialAssessmentId)) ||
        (value.initialCoverageGroupId !== null && !boundedId(value.initialCoverageGroupId)) ||
        (value.resolution === 'RESOLVED' ? Number(value.initialAssessmentId !== null) + Number(value.initialCoverageGroupId !== null) !== 1 : value.initialAssessmentId !== null || value.initialCoverageGroupId !== null)) return null;
    const at = parseTrainingCompletionTime(value.playedAt, receivedAt);
    const time = value.timeSpentMs === null ? null : parseTimeSpentMs(value.timeSpentMs);
    if (!at || time === 'INVALID') return null;
    return { ...value, playedAt: at.toISOString(), timeSpentMs: time } as RecordTrainingAttemptRequest;
}

export function parseEnrichTrainingAttemptRequest(value: unknown, receivedAt = new Date()): EnrichTrainingAttemptRequest | null {
    if (!isObject(value) || value.kind !== 'ENRICH' || !eventIdentity(value) ||
        !hasOnlyKeys(value, ['kind','clientAttemptId','momentRevisionId','stepIndex','eventId','sequence','supersedesEventId','evaluatedAt','resolution','assessmentId','evaluation']) ||
        !stepIndex(value.stepIndex) || typeof value.eventId !== 'string' || !isTrainingApiUuid(value.eventId) ||
        !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
        (value.sequence === 1 ? value.supersedesEventId !== null : typeof value.supersedesEventId !== 'string' || !isTrainingApiUuid(value.supersedesEventId)) ||
        value.supersedesEventId === value.eventId) return null;
    const at = parseTrainingCompletionTime(value.evaluatedAt, receivedAt);
    if (!at) return null;
    if (value.resolution === 'UNAVAILABLE') {
        if (value.assessmentId !== null || value.evaluation !== null) return null;
    } else if (value.resolution === 'RESOLVED') {
        if (!boundedId(value.assessmentId) || !isObject(value.evaluation) ||
            !hasOnlyKeys(value.evaluation, ['frame','assessments','evidence']) || !isObject(value.evaluation.frame) ||
            !Array.isArray(value.evaluation.assessments) || !isObject(value.evaluation.evidence) || !boundedClientJson(value.evaluation)) return null;
    } else return null;
    // Full evidence and policy validation needs the owned immutable revision and happens in the service.
    return { ...value, evaluatedAt: at.toISOString() } as EnrichTrainingAttemptRequest;
}
function boundedClientJson(value: unknown, depth = 0): boolean {
    if (depth > 16) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= 4096;
    if (Array.isArray(value)) return value.length <= 512 && value.every(item => boundedClientJson(item, depth + 1));
    return isObject(value) && Object.keys(value).length <= 512 && Object.values(value).every(item => boundedClientJson(item, depth + 1));
}
