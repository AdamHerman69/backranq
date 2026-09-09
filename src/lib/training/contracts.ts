import type { GameSource } from '@/lib/types/game';
import { canonicalPracticeSemantics, type PracticeMomentRevision } from './practiceContract';

export const TRAINING_CONTRACT_VERSION = 5 as const;
export const TRAINING_MOMENT_KEY_VERSION = 1 as const;

export const TRAINING_SOURCE_KINDS = [
    'MY_MISTAKE',
    'MISSED_OPPORTUNITY',
] as const;
export type TrainingSourceKind = (typeof TRAINING_SOURCE_KINDS)[number];

export const TRAINING_LESSON_KINDS = [
    'AVOID_MISTAKE',
    'PUNISH_MISTAKE',
    'SAVE_DRAW',
    'PRESERVE_WIN',
    'CONVERT_ADVANTAGE',
    'IMPROVE_POSITION',
] as const;
export type TrainingLessonKind = (typeof TRAINING_LESSON_KINDS)[number];

/**
 * A score whose point of view is explicit. Mate and tablebase outcomes are
 * deliberately not collapsed into synthetic centipawn values.
 */
export type PovScore =
    | { kind: 'cp'; cp: number; pov: 'WHITE' }
    | {
          kind: 'mate';
          plies: number;
          winner: 'WHITE' | 'BLACK';
      }
    | {
          kind: 'tablebase';
          wdl: 'WIN' | 'DRAW' | 'LOSS';
          pov: 'WHITE';
          dtz?: number;
      };

export type TrainingMomentIdentity = {
    gameId: string;
    sourcePgnHash: string;
    decisionPly: number;
};

export type TrainingMomentMetadata = {
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
};

/** Canonical v5 manifest plus the enclosing immutable analysis configuration. */
export type SolutionRevisionInput = {
    manifest: PracticeMomentRevision;
    configHash: string;
};

export function isTrainableSolution(solution: SolutionRevisionInput): boolean {
    const { selection, rootAnswerIndex } = solution.manifest;
    return selection.status === 'INCLUDED'
        && rootAnswerIndex.legalMovesUci.includes(rootAnswerIndex.preferredMoveUci);
}

export type TrainingMomentCandidate = {
    sourceGameId: string;
    sourceProvider: GameSource;
    sourcePlayedAt: string;
    sourcePgnHash: string;
    decisionPly: number;
    fen: string;
    positionHistory: string[];
    sideToMove: 'w' | 'b';
    originalMoveUci: string;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
    originalDecision: {
        scoreBefore: PovScore;
        scoreAfter: PovScore;
        cpLoss?: number;
        winChanceLoss?: number;
    };
    confidence?: number;
    phase?: 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';
    solution: SolutionRevisionInput;
};

export function requiredCanonicalPart(value: string, field: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) throw new Error(`${field} is required`);
    return normalized;
}

export function nonNegativeSafeInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return value;
}

const sourceKindOrder = new Map(
    TRAINING_SOURCE_KINDS.map((value, index) => [value, index])
);
const lessonKindOrder = new Map(
    TRAINING_LESSON_KINDS.map((value, index) => [value, index])
);

function canonicalEnumValues<T extends string>(
    values: readonly T[],
    order: ReadonlyMap<T, number>
): T[] {
    return Array.from(new Set(values)).sort(
        (left, right) =>
            (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
}

function canonicalThemes(values: readonly string[]): string[] {
    return Array.from(
        new Set(
            values
                .map(normalizeThemeId)
                .filter(Boolean)
                .map((value) => value.slice(0, 64))
        )
    )
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 64);
}

export function normalizeThemeId(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Merge extraction reasons for the same decision without making either
 * source kind part of the moment identity.
 */
export function mergeTrainingMomentMetadata(
    ...metadata: Array<
        Partial<
            Pick<
                TrainingMomentMetadata,
                'sourceKinds' | 'lessonKinds' | 'themes'
            >
        >
    >
): TrainingMomentMetadata {
    const sourceKinds = canonicalEnumValues(
        metadata.flatMap((item) => item.sourceKinds ?? []),
        sourceKindOrder
    );
    const lessonKinds = canonicalEnumValues(
        metadata.flatMap((item) => item.lessonKinds ?? []),
        lessonKindOrder
    );
    const themes = canonicalThemes(
        metadata.flatMap((item) => item.themes ?? [])
    );

    return {
        sourceKinds,
        lessonKinds,
        themes,
    };
}

function canonicalize(value: unknown): unknown {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'object') return value;

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) output[key] = canonicalize(item);
    }
    return output;
}

export function stableCanonicalStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

/**
 * Canonicalize only grading-relevant solution semantics. Engine provenance and
 * verification evidence may produce a new immutable revision without making
 * an otherwise equivalent solution appear different.
 */
export function canonicalSolutionSemantics(input: SolutionRevisionInput): unknown {
    return canonicalPracticeSemantics(input.manifest);
}
