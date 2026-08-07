import type {
    AttemptGrade,
    AcceptanceFrontier,
    GradingPolicyV3,
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';
import type { GameSource } from '@/lib/types/game';

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
    includeAttempted?: boolean;
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
    grading: TrainingGradingManifestDto;
};

export type TrainingSolutionTreeNodeDto = {
    fen: string;
    ply: number;
    role: 'USER' | 'OPPONENT' | 'TERMINAL';
    acceptedMovesUci: string[];
    selectedMoveUci?: string;
    alternativesComplete?: boolean;
    stopReason?: string;
    branches: Array<{
        moveUci: string;
        best: boolean;
        child: TrainingSolutionTreeNodeDto;
    }>;
};

export type TrainingMoveAssessmentDto = {
    decisionIndex: number;
    fen: string;
    moveUci: string;
    source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    grade: AttemptGrade;
    scoreAfter: PovScore | null;
    evidence: unknown;
};

/**
 * Everything needed to grade a position in the browser. This is deliberately
 * shipped with the prompt: Practice is self-directed, so hiding solutions from
 * DevTools is not a product or security boundary.
 */
export type TrainingGradingManifestDto = {
    version: 1;
    trainingSide: 'w' | 'b';
    positionHistory: string[];
    originalMoveUci: string;
    originalScoreAfter: PovScore;
    gradingPolicy: GradingPolicyV3;
    acceptanceFrontier: AcceptanceFrontier;
    solutionTree: TrainingSolutionTreeNodeDto;
    moveAssessments: TrainingMoveAssessmentDto[];
    review: TrainingReviewDto;
};

export type PracticeFeedResponse = {
    items: TrainingPromptDto[];
    nextCursor: string | null;
    /**
     * Effective filters after applying the user's saved defaults. Send these
     * with the cursor so an in-progress feed snapshot cannot change underneath
     * the user when preferences are edited elsewhere.
     */
    appliedFilters: PracticeFilters;
};

export type TrainingMomentResponse = {
    moment: TrainingPromptDto;
};

export type RecordedTrainingAttemptStepDto = {
    stepIndex: number;
    actor: 'USER' | 'ENGINE';
    fenBefore: string;
    moveUci: string;
    grade?: AttemptGrade;
    source?: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    comparison?: TrainingComparisonDto | null;
    timeSpentMs?: number;
};

export type RecordTrainingAttemptRequest = {
    kind: 'RECORD';
    clientAttemptId: string;
    solutionRevisionId: string;
    status: 'GRADED' | 'REVEALED';
    grade?: AttemptGrade;
    gradingSource?: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    comparison?: TrainingComparisonDto | null;
    steps: RecordedTrainingAttemptStepDto[];
};

export type RecordTrainingAttemptResponse = {
    attemptId: string;
    status: 'RECORDED';
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
    attemptId: string;
    status: 'GRADED';
    grade: AttemptGrade;
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
    | 'NOT_FOUND'
    | 'INVALID_REQUEST'
    | 'ILLEGAL_MOVE'
    | 'IDEMPOTENCY_CONFLICT'
    | 'STALE_REVISION';

export type TrainingApiErrorResponse = {
    error: string;
    code: TrainingApiErrorCode;
};
