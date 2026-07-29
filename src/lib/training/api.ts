import type {
    AttemptGrade,
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';
import type { Provider } from '@/lib/types/game';

export const TRAINING_SESSION_MAX_LIMIT = 50;
export const TRAINING_API_MAX_ID_LENGTH = 128;

export type TrainingPhase = 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';
export const TRAINING_SESSION_FOCUSES = [
    'ALL',
    'MEANINGFUL',
    'MAJOR',
] as const;
export type TrainingSessionFocus =
    (typeof TRAINING_SESSION_FOCUSES)[number];

export type TrainingSessionFilters = {
    /**
     * User-facing session intensity. Thresholds remain a server policy so the
     * client never needs to know engine scores or extraction internals.
     */
    focus?: TrainingSessionFocus;
    phases?: TrainingPhase[];
    sourceKinds?: TrainingSourceKind[];
    lessonKinds?: TrainingLessonKind[];
    themes?: string[];
    minConfidence?: number;
    includeAttempted?: boolean;
};

export type TrainingSessionRequest = {
    limit?: number;
    cursor?: string;
    filters?: TrainingSessionFilters;
};

/**
 * The complete pre-attempt disclosure boundary. Do not add source metadata,
 * original move, themes, lesson/source kinds, solution shape/length, engine
 * scores, best/accepted moves or PV data to this DTO.
 */
export type TrainingPromptDto = {
    id: string;
    solutionRevisionId: string;
    fen: string;
    sideToMove: 'w' | 'b';
};

export type TrainingSessionResponse = {
    items: TrainingPromptDto[];
    nextCursor: string | null;
    /**
     * Effective filters after applying the user's saved defaults. Send these
     * with the cursor so an in-progress session cannot change underneath the
     * user when preferences are edited elsewhere.
     */
    appliedFilters: TrainingSessionFilters;
};

export type TrainingMomentResponse = {
    moment: TrainingPromptDto;
};

export type StartTrainingAttemptRequest = {
    kind: 'START';
    clientAttemptId: string;
    solutionRevisionId: string;
    moveUci: string;
    timeSpentMs?: number;
};

export type ContinueTrainingAttemptRequest = {
    kind: 'STEP';
    clientAttemptId: string;
    attemptId: string;
    stepIndex: number;
    moveUci: string;
    timeSpentMs?: number;
};

export type RetryTrainingAttemptRequest = {
    kind: 'RETRY';
    clientAttemptId: string;
    attemptId: string;
    stepIndex: number;
    retryId: string;
};

export type SubmitTrainingAttemptRequest =
    | StartTrainingAttemptRequest
    | ContinueTrainingAttemptRequest
    | RetryTrainingAttemptRequest;

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
        provider: Provider;
        playedAt: string;
        decisionPly: number;
    };
};

export type GradedTrainingAttemptResponse = {
    attemptId: string;
    status: 'GRADED';
    grade: AttemptGrade;
    accepted: boolean;
    review: TrainingReviewDto;
};

export type UnresolvedTrainingAttemptResponse = {
    attemptId: string;
    status: 'UNRESOLVED';
    reason:
        | 'ENGINE_UNAVAILABLE'
        | 'UNSTABLE_EVIDENCE'
        | 'MISSING_OUTCOME_EVIDENCE';
    retryAfterMs?: number;
};

export type ContinueTrainingAttemptResponse = {
    attemptId: string;
    status: 'AWAITING_CONTINUATION';
    nextStepIndex: number;
    opponentMove: TrainingOpponentMoveDto;
};

export type SubmitTrainingAttemptResponse =
    | GradedTrainingAttemptResponse
    | UnresolvedTrainingAttemptResponse
    | ContinueTrainingAttemptResponse;

export type RevealTrainingMomentRequest = {
    clientAttemptId: string;
    solutionRevisionId: string;
};

export type RevealTrainingMomentResponse = {
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
    | 'STALE_REVISION'
    | 'GRADING_BUSY'
    | 'RATE_LIMITED';

export type TrainingApiErrorResponse = {
    error: string;
    code: TrainingApiErrorCode;
    retryAfterMs?: number;
};
