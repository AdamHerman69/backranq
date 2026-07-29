import {
    TRAINING_API_MAX_ID_LENGTH,
    TRAINING_SESSION_FOCUSES,
    TRAINING_SESSION_MAX_LIMIT,
    type RevealTrainingMomentRequest,
    type SubmitTrainingAttemptRequest,
    type TrainingPhase,
    type TrainingSessionFocus,
    type TrainingSessionRequest,
} from '@/lib/training/api';
import {
    TRAINING_LESSON_KINDS,
    TRAINING_SOURCE_KINDS,
    type TrainingLessonKind,
    type TrainingSourceKind,
} from '@/lib/training/contracts';

export const MAX_TRAINING_API_BODY_BYTES = 8_192;
export const MAX_TRAINING_ATTEMPT_TIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_TRAINING_CONTINUATION_STEPS = 64;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const PHASES = ['OPENING', 'MIDDLEGAME', 'ENDGAME'] as const;
const SESSION_QUERY_KEYS = new Set([
    'limit',
    'cursor',
    'focus',
    'phase',
    'sourceKind',
    'lessonKind',
    'theme',
    'minConfidence',
    'includeAttempted',
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

export function parseTrainingSessionRequest(
    url: URL
): TrainingSessionRequest | null {
    if (
        Array.from(url.searchParams.keys()).some(
            (key) => !SESSION_QUERY_KEYS.has(key)
        ) ||
        [
            'limit',
            'cursor',
            'focus',
            'minConfidence',
            'includeAttempted',
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
        limit > TRAINING_SESSION_MAX_LIMIT
    ) {
        return null;
    }
    const cursor = url.searchParams.get('cursor')?.trim() || undefined;
    if (cursor && cursor.length > 512) return null;
    const rawFocus = url.searchParams.get('focus');
    const focus =
        rawFocus == null
            ? undefined
            : rawFocus.trim().toUpperCase();
    if (
        focus !== undefined &&
        !(TRAINING_SESSION_FOCUSES as readonly string[]).includes(
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
    const rawIncludeAttempted = url.searchParams.get('includeAttempted');
    if (
        rawIncludeAttempted !== null &&
        rawIncludeAttempted !== 'true' &&
        rawIncludeAttempted !== 'false'
    ) {
        return null;
    }

    return {
        limit,
        ...(cursor ? { cursor } : {}),
        filters: {
            ...(focus !== undefined
                ? {
                      focus: focus as TrainingSessionFocus,
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
            ...(rawIncludeAttempted !== null
                ? { includeAttempted: rawIncludeAttempted === 'true' }
                : {}),
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

export function parseSubmitTrainingAttemptRequest(
    value: unknown
): SubmitTrainingAttemptRequest | null {
    if (!isObject(value)) return null;
    if (
        value.kind === 'START' &&
        !hasOnlyKeys(value, [
            'kind',
            'clientAttemptId',
            'solutionRevisionId',
            'moveUci',
            'timeSpentMs',
        ])
    ) {
        return null;
    }
    if (
        value.kind === 'STEP' &&
        !hasOnlyKeys(value, [
            'kind',
            'clientAttemptId',
            'attemptId',
            'stepIndex',
            'moveUci',
            'timeSpentMs',
        ])
    ) {
        return null;
    }
    if (
        value.kind === 'RETRY' &&
        !hasOnlyKeys(value, [
            'kind',
            'clientAttemptId',
            'attemptId',
            'stepIndex',
            'retryId',
        ])
    ) {
        return null;
    }
    const clientAttemptId =
        typeof value.clientAttemptId === 'string'
            ? value.clientAttemptId.trim().toLowerCase()
            : '';
    if (!isTrainingApiUuid(clientAttemptId)) return null;
    if (value.kind === 'RETRY') {
        const attemptId =
            typeof value.attemptId === 'string'
                ? value.attemptId.trim().toLowerCase()
                : '';
        const retryId =
            typeof value.retryId === 'string'
                ? value.retryId.trim().toLowerCase()
                : '';
        if (
            !isTrainingApiUuid(attemptId) ||
            !isTrainingApiUuid(retryId) ||
            !Number.isSafeInteger(value.stepIndex) ||
            (value.stepIndex as number) < 0 ||
            (value.stepIndex as number) >
                MAX_TRAINING_CONTINUATION_STEPS
        ) {
            return null;
        }
        return {
            kind: 'RETRY',
            clientAttemptId,
            attemptId,
            stepIndex: value.stepIndex as number,
            retryId,
        };
    }
    const moveUci =
        typeof value.moveUci === 'string'
            ? value.moveUci.trim().toLowerCase()
            : '';
    const timeSpentMs = parseTimeSpentMs(value.timeSpentMs);
    if (
        !UCI_RE.test(moveUci) ||
        timeSpentMs === 'INVALID'
    ) {
        return null;
    }

    if (value.kind === 'START') {
        const solutionRevisionId =
            typeof value.solutionRevisionId === 'string'
                ? value.solutionRevisionId.trim().toLowerCase()
                : '';
        if (!isTrainingApiUuid(solutionRevisionId)) return null;
        return {
            kind: 'START',
            clientAttemptId,
            solutionRevisionId,
            moveUci,
            ...(timeSpentMs == null ? {} : { timeSpentMs }),
        };
    }
    if (value.kind === 'STEP') {
        const attemptId =
            typeof value.attemptId === 'string'
                ? value.attemptId.trim().toLowerCase()
                : '';
        if (
            !isTrainingApiUuid(attemptId) ||
            !Number.isSafeInteger(value.stepIndex) ||
            (value.stepIndex as number) < 0 ||
            (value.stepIndex as number) > MAX_TRAINING_CONTINUATION_STEPS
        ) {
            return null;
        }
        return {
            kind: 'STEP',
            clientAttemptId,
            attemptId,
            stepIndex: value.stepIndex as number,
            moveUci,
            ...(timeSpentMs == null ? {} : { timeSpentMs }),
        };
    }
    return null;
}

export function parseRevealTrainingMomentRequest(
    value: unknown
): RevealTrainingMomentRequest | null {
    if (
        !isObject(value) ||
        !hasOnlyKeys(value, [
            'clientAttemptId',
            'solutionRevisionId',
        ])
    ) {
        return null;
    }
    const clientAttemptId =
        typeof value.clientAttemptId === 'string'
            ? value.clientAttemptId.trim().toLowerCase()
            : '';
    const solutionRevisionId =
        typeof value.solutionRevisionId === 'string'
            ? value.solutionRevisionId.trim().toLowerCase()
            : '';
    if (
        !isTrainingApiUuid(clientAttemptId) ||
        !isTrainingApiUuid(solutionRevisionId)
    ) {
        return null;
    }
    return { clientAttemptId, solutionRevisionId };
}
