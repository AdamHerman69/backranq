import type { PovScore, TrainingLessonKind, TrainingSourceKind } from './contracts';
import type { Continuation, MoveAssessment, PracticeMomentRevision, Quality, Tier } from './practiceContract';
import type { GameSource } from '@/lib/types/game';
export type { RecordPlayedMoveRequest, RevealTrainingAttemptRequest, RecordTrainingAttemptRequest,
    EnrichTrainingAttemptRequest, RecordTrainingAttemptResponse, EnrichTrainingAttemptResponse,
    TrainingAttemptWriteRequest } from './attemptApi';

export const PRACTICE_FEED_MAX_LIMIT = 50;
export const TRAINING_API_MAX_ID_LENGTH = 128;

export type TrainingPhase = 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';
export const PRACTICE_FEED_FOCUSES = [
    'ALL',
    'MEANINGFUL',
    'MAJOR',
] as const;
export type PracticeFeedFocus =
    (typeof PRACTICE_FEED_FOCUSES)[number];

export const PRACTICE_FEED_MODES = [
    'RECOMMENDED',
    'REVIEW',
    'NEW',
] as const;
export type PracticeFeedMode =
    (typeof PRACTICE_FEED_MODES)[number];

export type PracticeFilters = {
    /**
     * User-facing practice intensity. Thresholds remain a server policy so the
     * client never needs to know engine scores or extraction internals.
     */
    focus?: PracticeFeedFocus;
    phases?: TrainingPhase[];
    sourceKinds?: TrainingSourceKind[];
    lessonKinds?: TrainingLessonKind[];
    themes?: string[];
    minConfidence?: number;
    mode?: PracticeFeedMode;
    /** Restrict the session to positions extracted from one owned game. */
    gameId?: string;
};

export type PracticeFeedRequest = {
    limit?: number;
    cursor?: string;
    filters?: PracticeFilters;
};

/**
 * One fully self-contained practice position. The UI remains neutral before a
 * move, but the downloaded payload intentionally includes local grading data:
 * self-directed practice does not treat DevTools inspection as a threat.
 */
export type TrainingPromptDto = {
    id: string;
    solutionRevisionId: string;
    fen: string;
    sideToMove: 'w' | 'b';
    grading: PracticeMomentRevision;
    review: TrainingReviewDto;
};

/** A presentation cursor into the canonical continuation graph. */
export type TrainingSolutionTreeNodeDto = Continuation['nodes'][number] & { ply: number };

export type TrainingMoveAssessmentDto = MoveAssessment;
export type TrainingGradingManifestDto = PracticeMomentRevision;

export type PracticeFeedResponse = {
    ownerId: string;
    items: TrainingPromptDto[];
    nextCursor: string | null;
    /**
     * Effective filters after applying the user's saved defaults. Send these
     * with the cursor so an in-progress feed snapshot cannot change underneath
     * the user when preferences are edited elsewhere.
     */
    appliedFilters: PracticeFilters;
};

/**
 * Server-rendered hand-off for Practice. A regular feed starts with one prompt
 * and a cursor immediately after it; a moment deep-link starts with the prompt
 * only and lets the client fill the unrelated feed after the first paint.
 */
export type PracticeFeedInitialData = {
    ownerId: string;
    prompt: TrainingPromptDto | null;
    nextCursor: string | null;
    appliedFilters: PracticeFilters;
    feedStarted: boolean;
    feedHadPositions: boolean;
    loadError: string | null;
};

export type TrainingMomentResponse = {
    ownerId: string;
    moment: TrainingPromptDto;
};

export type TrainingOpponentMoveDto = {
    moveUci: string;
    fenAfter: string;
};

export type TrainingComparisonDto = {
    submittedScoreAfter: PovScore | null;
    bestGapCp: number | null;
    bestGapWinChance: number | null;
    recoveredCp: number | null;
    recoveredWinChance: number | null;
    preservesOutcome: boolean | null;
};

export type TrainingReviewDto = {
    trainingSide: 'w' | 'b';
    originalMoveUci: string;
    submittedMoveUci: string | null;
    bestMoveUci: string;
    acceptedMovesUci: string[];
    acceptedMovesComplete: boolean;
    bestLineUci: string[];
    scoreAtStart: PovScore | null;
    originalDecision: {
        scoreBefore: PovScore;
        scoreAfter: PovScore;
        cpLoss: number | null;
        winChanceLoss: number | null;
    };
    comparison: TrainingComparisonDto | null;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
    source: {
        gameId: string;
        provider: GameSource;
        playedAt: string;
        decisionPly: number;
    };
};

export type GradedPracticeResult = {
    refinement?: 'PENDING' | 'REFINED' | 'CORRECTED' | 'UNRESOLVED';
    attemptId: string;
    status: 'GRADED';
    quality: Exclude<Quality, 'UNKNOWN'>;
    tier: Tier | null;
    originalRelation: MoveAssessment['originalRelation'];
    accepted: boolean;
    review: TrainingReviewDto;
};

export type UnresolvedPracticeResult = {
    attemptId: string;
    status: 'UNRESOLVED';
    reason:
        | 'ENGINE_UNAVAILABLE'
        | 'UNSTABLE_EVIDENCE'
        | 'MISSING_OUTCOME_EVIDENCE';
};

export type PracticeContinuation = {
    attemptId: string;
    status: 'AWAITING_CONTINUATION';
    nextStepIndex: number;
    opponentMove: TrainingOpponentMoveDto;
};

export type PracticeResult =
    | GradedPracticeResult
    | UnresolvedPracticeResult
    | PracticeContinuation;

export type RevealedPracticeResult = {
    attemptId: string;
    status: 'REVEALED';
    review: TrainingReviewDto;
};

export type TrainingApiErrorCode =
    | 'UNAUTHORIZED'
    | 'OWNER_MISMATCH'
    | 'NOT_FOUND'
    | 'INVALID_REQUEST'
    | 'ILLEGAL_MOVE'
    | 'IDEMPOTENCY_CONFLICT'
    | 'STALE_REVISION';

export type TrainingApiErrorResponse = {
    error: string;
    code: TrainingApiErrorCode;
};
