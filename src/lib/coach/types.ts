import type { Square } from 'chess.js';

import type { MultiPvResult } from '@/lib/analysis/stockfishClient';
import type {
    EngineEvaluation,
    UserMoveAssessment,
} from '@/lib/coach/assessment';
import type {
    CoachOpponentModelId,
    OpponentProfileId,
} from '@/lib/coach/profiles';
import type { CoachVerificationEvidence } from '@/lib/coach/verification';

export type CoachGamePhase =
    | 'setup'
    | 'starting'
    | 'preparing'
    | 'player'
    | 'checking'
    | 'confirming'
    | 'bot'
    | 'mistake'
    | 'analysis'
    | 'gameover'
    | 'recovering'
    | 'error';

export type CoachColorChoice = 'white' | 'black' | 'random';
export type CoachPromotionPiece = 'q' | 'r' | 'b' | 'n';
export type CoachEngineWarmupStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'error';

export type CoachPlayedMove = {
    ply: number;
    actor: 'player' | 'bot';
    san: string;
    uci: string;
    fenBefore: string;
    fenAfter: string;
    from: Square;
    to: Square;
};

export type CoachMistake = {
    id: string;
    decisionPly: number;
    decisionFen: string;
    fenAfterMove: string;
    positionHistory: string[];
    moveUci: string;
    moveSan: string;
    bestMoveUci: string;
    bestLineUci: string[];
    beforeAnalysis: MultiPvResult;
    afterAnalysis: MultiPvResult | null;
    afterEvaluation: EngineEvaluation;
    assessment: UserMoveAssessment;
    verification: CoachVerificationEvidence;
};

export type CoachPendingDecision = {
    record: CoachPlayedMove;
    beforeAnalysis: MultiPvResult;
};

export type CoachResumablePhase =
    | 'preparing'
    | 'player'
    | 'checking'
    | 'confirming'
    | 'bot'
    | 'mistake';

type CoachSessionSnapshotBase = {
    version: 4;
    sessionKey: string;
    ownerId: string;
    savedAt: number;
    userColor: 'w' | 'b';
    opponentModel: CoachOpponentModelId;
    opponentId: OpponentProfileId;
    opponentElo: number | null;
    opponentEngineRevision: string;
    tacticalGuardCp: number | null;
    thresholdCp: number;
    gameFen: string;
    moves: CoachPlayedMove[];
    positionFens: string[];
    baseline: MultiPvResult | null;
    pendingDecision: CoachPendingDecision | null;
    mistake: CoachMistake | null;
    mistakes: CoachMistake[];
    flipped: boolean;
};

export type CoachActiveSessionSnapshot = CoachSessionSnapshotBase & {
    phase: CoachResumablePhase;
};

export type CoachCompletedSessionSnapshot = CoachSessionSnapshotBase & {
    phase: 'gameover';
    completedAt: string;
};

export type CoachSessionSnapshot =
    | CoachActiveSessionSnapshot
    | CoachCompletedSessionSnapshot;
