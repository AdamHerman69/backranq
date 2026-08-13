import {
    TRAINING_API_MAX_ID_LENGTH,
    PRACTICE_FEED_MAX_LIMIT,
    PRACTICE_FEED_FOCUSES,
    PRACTICE_FEED_MODES,
    type PracticeFeedFocus,
    type PracticeFeedRequest,
    type RecordTrainingAttemptRequest,
    type RecordedTrainingAttemptStepDto,
    type TrainingComparisonDto,
    type TrainingPhase,
} from '@/lib/training/api';
import {
    ATTEMPT_GRADES,
    TRAINING_LESSON_KINDS,
    TRAINING_SOURCE_KINDS,
    type TrainingLessonKind,
    type TrainingSourceKind,
} from '@/lib/training/contracts';
import { isPovScore } from '@/lib/training/apiMappers';

export const MAX_TRAINING_API_BODY_BYTES = 65_536;
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

export function parseRecordTrainingAttemptRequest(
    value: unknown
): RecordTrainingAttemptRequest | null {
    if (
        !isObject(value) ||
        value.kind !== 'RECORD' ||
        !hasOnlyKeys(value, [
            'kind',
            'clientAttemptId',
            'solutionRevisionId',
            'status',
            'grade',
            'gradingSource',
            'comparison',
            'steps',
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
        !isTrainingApiUuid(solutionRevisionId) ||
        (value.status !== 'GRADED' &&
            value.status !== 'REVEALED') ||
        !Array.isArray(value.steps) ||
        value.steps.length >
            MAX_TRAINING_CONTINUATION_STEPS + 1
    ) {
        return null;
    }
    const grade =
        typeof value.grade === 'string' &&
        (ATTEMPT_GRADES as readonly string[]).includes(value.grade)
            ? (value.grade as RecordTrainingAttemptRequest['grade'])
            : undefined;
    if (value.grade !== undefined && !grade) return null;
    const gradingSource =
        value.gradingSource === 'PRECOMPUTED' ||
        value.gradingSource === 'DYNAMIC' ||
        value.gradingSource === 'TABLEBASE'
            ? value.gradingSource
            : undefined;
    if (value.gradingSource !== undefined && !gradingSource) {
        return null;
    }
    const comparison = parseComparison(value.comparison);
    if (comparison === 'INVALID') return null;
    const steps: RecordedTrainingAttemptStepDto[] = [];
    for (const rawStep of value.steps) {
        const step = parseRecordedStep(rawStep);
        if (!step) return null;
        steps.push(step);
    }
    return {
        kind: 'RECORD',
        clientAttemptId,
        solutionRevisionId,
        status: value.status,
        ...(grade ? { grade } : {}),
        ...(gradingSource ? { gradingSource } : {}),
        ...(comparison === undefined ? {} : { comparison }),
        steps,
    };
}

function parseComparison(
    value: unknown
): TrainingComparisonDto | null | undefined | 'INVALID' {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (
        !isObject(value) ||
        !hasOnlyKeys(value, [
            'submittedScoreAfter',
            'bestGapCp',
            'bestGapWinChance',
            'recoveredCp',
            'recoveredWinChance',
            'preservesOutcome',
        ])
    ) {
        return 'INVALID';
    }
    const numericKeys = [
        'bestGapCp',
        'bestGapWinChance',
        'recoveredCp',
        'recoveredWinChance',
    ] as const;
    for (const key of numericKeys) {
        const item = value[key];
        if (
            item !== null &&
            (typeof item !== 'number' ||
                !Number.isFinite(item) ||
                item < 0)
        ) {
            return 'INVALID';
        }
    }
    if (
        value.submittedScoreAfter !== null &&
        !isPovScore(value.submittedScoreAfter)
    ) {
        return 'INVALID';
    }
    if (
        value.preservesOutcome !== null &&
        typeof value.preservesOutcome !== 'boolean'
    ) {
        return 'INVALID';
    }
    return value as TrainingComparisonDto;
}

function parseRecordedStep(
    value: unknown
): RecordedTrainingAttemptStepDto | null {
    if (
        !isObject(value) ||
        !hasOnlyKeys(value, [
            'stepIndex',
            'actor',
            'fenBefore',
            'moveUci',
            'grade',
            'source',
            'comparison',
            'timeSpentMs',
        ]) ||
        !Number.isSafeInteger(value.stepIndex) ||
        (value.stepIndex as number) < 0 ||
        (value.stepIndex as number) >
            MAX_TRAINING_CONTINUATION_STEPS ||
        (value.actor !== 'USER' && value.actor !== 'ENGINE') ||
        typeof value.fenBefore !== 'string' ||
        value.fenBefore.length > 128
    ) {
        return null;
    }
    const moveUci =
        typeof value.moveUci === 'string'
            ? value.moveUci.trim().toLowerCase()
            : '';
    const timeSpentMs = parseTimeSpentMs(value.timeSpentMs);
    if (!UCI_RE.test(moveUci) || timeSpentMs === 'INVALID') {
        return null;
    }
    const grade =
        typeof value.grade === 'string' &&
        (ATTEMPT_GRADES as readonly string[]).includes(value.grade)
            ? (value.grade as RecordedTrainingAttemptStepDto['grade'])
            : undefined;
    if (value.grade !== undefined && !grade) return null;
    const source =
        value.source === 'PRECOMPUTED' ||
        value.source === 'DYNAMIC' ||
        value.source === 'TABLEBASE'
            ? value.source
            : undefined;
    if (value.source !== undefined && !source) return null;
    const comparison = parseComparison(value.comparison);
    if (comparison === 'INVALID') return null;
    return {
        stepIndex: value.stepIndex as number,
        actor: value.actor,
        fenBefore: value.fenBefore,
        moveUci,
        ...(grade ? { grade } : {}),
        ...(source ? { source } : {}),
        ...(comparison === undefined ? {} : { comparison }),
        ...(timeSpentMs == null ? {} : { timeSpentMs }),
    };
}
