import { Chess } from 'chess.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import {
    LichessTablebaseClient,
    type TablebaseEvidence,
} from '@/lib/analysis/tablebase';
import type {
    RevealTrainingMomentRequest,
    RevealTrainingMomentResponse,
    SubmitTrainingAttemptRequest,
    SubmitTrainingAttemptResponse,
    TrainingApiErrorCode,
    TrainingComparisonDto,
    TrainingOpponentMoveDto,
} from '@/lib/training/api';
import {
    nullablePovScore,
    toTrainingReviewDto,
} from '@/lib/training/apiMappers';
import type {
    AttemptGrade,
    GradingPolicyV2,
    PovScore,
} from '@/lib/training/contracts';
import {
    engineScoreToWhitePov,
    engineWdlChance,
    metricsFromMatchedOutcomeEvidence,
    metricsFromPovScores,
    scoreForTrainingSide,
    trainingWdlToWhitePov,
} from '@/lib/training/gradingEvidence';
import {
    gradeTrainingMove,
    type TrainingMoveGradeResult,
    type TrainingMoveMetrics,
} from '@/lib/training/grader';
import {
    MAX_ASSESSMENT_POSITION_HISTORY,
    assessmentPositionKey,
} from '@/lib/training/assessmentIdentity';

const DYNAMIC_RATE_LIMIT = 8;
const DYNAMIC_RATE_WINDOW_MS = 60_000;
// Four matched Stockfish probes can each consume their full 15s timeout.
// Keep the lease beyond that upper bound so a slow but healthy evaluator is
// never reclaimed and executed concurrently.
const ASSESSMENT_LEASE_MS = 90_000;
const STALE_PENDING_ATTEMPT_MS = 30 * 60_000;
const dynamicTablebase = new LichessTablebaseClient({
    timeoutMs: 4_000,
});

type TrainingWriteDb = Pick<
    PrismaClient,
    | '$transaction'
    | 'trainingMoment'
    | 'trainingAttempt'
    | 'trainingAttemptStep'
    | 'solutionMoveAssessment'
>;

const revisionSelect = {
    id: true,
    momentId: true,
    verificationStatus: true,
    trainable: true,
    continuationShape: true,
    solutionShape: true,
    bestMoveUci: true,
    acceptedMovesUci: true,
    bestLine: true,
    solutionTree: true,
    scoreAtStart: true,
    playedMoveScore: true,
    gradingPolicy: true,
} satisfies Prisma.SolutionRevisionSelect;

const momentBaseSelect = {
    id: true,
    userId: true,
    gameId: true,
    decisionPly: true,
    fen: true,
    positionHistory: true,
    sideToMove: true,
    originalMoveUci: true,
    scoreBefore: true,
    scoreAfter: true,
    cpLoss: true,
    winChanceLoss: true,
    sourceKinds: true,
    lessonKinds: true,
    themes: true,
    currentSolutionRevisionId: true,
    game: {
        select: {
            provider: true,
            playedAt: true,
        },
    },
} satisfies Prisma.TrainingMomentSelect;

const startMomentSelect = {
    ...momentBaseSelect,
    currentSolutionRevision: {
        select: revisionSelect,
    },
} satisfies Prisma.TrainingMomentSelect;

const attemptSelect = {
    id: true,
    trainingMomentId: true,
    userId: true,
    solutionRevisionId: true,
    clientAttemptId: true,
    attemptedAt: true,
    userMoveUci: true,
    timeSpentMs: true,
    status: true,
    grade: true,
    gradingSource: true,
    gradingEvidence: true,
    bestGapCp: true,
    bestGapWinChance: true,
    recoveredCp: true,
    recoveredWinChance: true,
    completedAt: true,
    trainingMoment: {
        select: momentBaseSelect,
    },
    solutionRevision: {
        select: revisionSelect,
    },
    steps: {
        orderBy: { stepIndex: 'asc' as const },
        select: {
            id: true,
            stepIndex: true,
            actor: true,
            fenBefore: true,
            moveUci: true,
            grade: true,
            evidence: true,
            timeSpentMs: true,
        },
    },
} satisfies Prisma.TrainingAttemptSelect;

type StartMoment = Prisma.TrainingMomentGetPayload<{
    select: typeof startMomentSelect;
}>;
type AttemptState = Prisma.TrainingAttemptGetPayload<{
    select: typeof attemptSelect;
}>;
type RevisionState = AttemptState['solutionRevision'];

type SolutionTreeNode = {
    fen: string;
    ply: number;
    role: 'USER' | 'OPPONENT' | 'TERMINAL';
    selectedMoveUci?: string;
    stopReason?: string;
    branches: Array<{
        moveUci: string;
        best: boolean;
        child: SolutionTreeNode;
    }>;
};

export type DynamicEvaluation = {
    source: 'DYNAMIC' | 'TABLEBASE';
    scoreAfter: PovScore | null;
    metrics: TrainingMoveMetrics;
    evidence: unknown;
};

type AssessedMove = {
    submittedScore: PovScore | null;
    metrics: TrainingMoveMetrics;
    source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    evidence: unknown;
    gradeResult?: TrainingMoveGradeResult;
};

export type TrainingAttemptDependencies = {
    db: TrainingWriteDb;
    now?: () => Date;
    evaluateDynamicMove?: (args: {
        fen: string;
        moveUci: string;
        trainingSide: 'w' | 'b';
        bestScore: PovScore | null;
        originalScore: PovScore | null;
        originalMoveUci: string;
        positionHistory: string[];
    }) => Promise<DynamicEvaluation>;
};

export class TrainingAttemptError extends Error {
    constructor(
        message: string,
        readonly code: TrainingApiErrorCode,
        readonly status: number,
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'TrainingAttemptError';
    }
}

function normalizeUci(move: string): string {
    return move.trim().toLowerCase();
}

function applyUci(fen: string, moveUci: string): string | null {
    try {
        const chess = new Chess(fen);
        const normalized = normalizeUci(moveUci);
        const move = chess.move({
            from: normalized.slice(0, 2),
            to: normalized.slice(2, 4),
            promotion: normalized.slice(4, 5) || undefined,
        });
        return move ? chess.fen() : null;
    } catch {
        return null;
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002'
    );
}

function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function parseGradingPolicy(value: unknown): GradingPolicyV2 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const policy = value as Partial<GradingPolicyV2>;
    return policy.version === 2 &&
        policy.pov === 'TRAINING_SIDE' &&
        policy.unknownMove === 'DYNAMIC' &&
        policy.matePolicy === 'EXACT' &&
        policy.tablebasePolicy === 'EXACT' &&
        policy.best &&
        policy.success &&
        policy.improvement
        ? (policy as GradingPolicyV2)
        : null;
}

function parseTree(value: unknown): SolutionTreeNode | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const node = value as Record<string, unknown>;
    if (
        typeof node.fen !== 'string' ||
        typeof node.ply !== 'number' ||
        (node.role !== 'USER' &&
            node.role !== 'OPPONENT' &&
            node.role !== 'TERMINAL') ||
        !Array.isArray(node.branches)
    ) {
        return null;
    }
    const branches: SolutionTreeNode['branches'] = [];
    for (const rawBranch of node.branches) {
        if (
            !rawBranch ||
            typeof rawBranch !== 'object' ||
            Array.isArray(rawBranch)
        ) {
            return null;
        }
        const branch = rawBranch as Record<string, unknown>;
        const child = parseTree(branch.child);
        if (
            typeof branch.moveUci !== 'string' ||
            typeof branch.best !== 'boolean' ||
            !child
        ) {
            return null;
        }
        branches.push({
            moveUci: normalizeUci(branch.moveUci),
            best: branch.best,
            child,
        });
    }
    return {
        fen: node.fen,
        ply: Math.trunc(node.ply),
        role: node.role,
        ...(typeof node.selectedMoveUci === 'string'
            ? { selectedMoveUci: normalizeUci(node.selectedMoveUci) }
            : {}),
        ...(typeof node.stopReason === 'string'
            ? { stopReason: node.stopReason }
            : {}),
        branches,
    };
}

function nodeBeforeStep(
    root: SolutionTreeNode | null,
    steps: AttemptState['steps'],
    stepIndex: number
): SolutionTreeNode | null {
    if (!root) return null;
    let node = root;
    for (const step of steps) {
        if (step.stepIndex >= stepIndex) break;
        if (node.fen !== step.fenBefore) return null;
        const branch = node.branches.find(
            (candidate) =>
                candidate.moveUci === normalizeUci(step.moveUci)
        );
        if (!branch) return null;
        node = branch.child;
    }
    return node;
}

function assessmentEvidence(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function comparisonFromMetrics(
    scoreAfter: PovScore | null,
    metrics: TrainingMoveMetrics
): TrainingComparisonDto {
    return {
        submittedScoreAfter: scoreAfter,
        bestGapCp: metrics.bestGapCp ?? null,
        bestGapWinChance: metrics.bestGapWinChance ?? null,
        recoveredCp: metrics.recoveredCp ?? null,
        recoveredWinChance: metrics.recoveredWinChance ?? null,
        preservesOutcome: metrics.preservesOutcome ?? null,
    };
}

function comparisonFromAttempt(
    attempt: AttemptState
): TrainingComparisonDto | null {
    const evidence = assessmentEvidence(attempt.gradingEvidence);
    const submittedScoreAfter = nullablePovScore(
        evidence.submittedScoreAfter
    );
    if (
        !submittedScoreAfter &&
        attempt.bestGapCp == null &&
        attempt.bestGapWinChance == null
    ) {
        return null;
    }
    return {
        submittedScoreAfter,
        bestGapCp: attempt.bestGapCp,
        bestGapWinChance: attempt.bestGapWinChance,
        recoveredCp: attempt.recoveredCp,
        recoveredWinChance: attempt.recoveredWinChance,
        preservesOutcome:
            typeof evidence.preservesOutcome === 'boolean'
                ? evidence.preservesOutcome
                : null,
    };
}

async function loadAttempt(
    db: TrainingWriteDb,
    attemptId: string,
    userId: string
): Promise<AttemptState | null> {
    return db.trainingAttempt.findFirst({
        where: { id: attemptId, userId },
        select: attemptSelect,
    });
}

function reviewForAttempt(attempt: AttemptState) {
    const userDecisionCount = attempt.steps.filter(
        (step) => step.actor === 'USER'
    ).length;
    return toTrainingReviewDto({
        moment: attempt.trainingMoment,
        revision: attempt.solutionRevision,
        submittedMoveUci: attempt.userMoveUci,
        // Attempt-level metrics are updated at every conditional decision.
        // Until the review contract carries per-step comparisons, showing the
        // final step beside the root move would be actively misleading.
        comparison:
            userDecisionCount <= 1
                ? comparisonFromAttempt(attempt)
                : null,
    });
}

function unresolvedReason(attempt: AttemptState) {
    const evidence = assessmentEvidence(attempt.gradingEvidence);
    return evidence.reason === 'UNSTABLE_EVIDENCE' ||
        evidence.reason === 'MISSING_OUTCOME_EVIDENCE'
        ? evidence.reason
        : ('ENGINE_UNAVAILABLE' as const);
}

function awaitingResponse(
    attempt: AttemptState
): SubmitTrainingAttemptResponse | null {
    const last = attempt.steps.at(-1);
    if (!last || last.actor !== 'ENGINE') return null;
    const fenAfter = applyUci(last.fenBefore, last.moveUci);
    if (!fenAfter) return null;
    return {
        attemptId: attempt.id,
        status: 'AWAITING_CONTINUATION',
        nextStepIndex: last.stepIndex + 1,
        opponentMove: {
            moveUci: last.moveUci,
            fenAfter,
        },
    };
}

function terminalResponse(
    attempt: AttemptState
): SubmitTrainingAttemptResponse | null {
    if (attempt.status === 'GRADED' && attempt.grade) {
        return {
            attemptId: attempt.id,
            status: 'GRADED',
            grade: attempt.grade,
            accepted:
                attempt.grade === 'BEST' || attempt.grade === 'GOOD',
            review: reviewForAttempt(attempt),
        };
    }
    if (attempt.status === 'UNRESOLVED') {
        return {
            attemptId: attempt.id,
            status: 'UNRESOLVED',
            reason: unresolvedReason(attempt),
        };
    }
    return attempt.status === 'PENDING'
        ? awaitingResponse(attempt)
        : null;
}

function assertIdempotentStart(
    attempt: AttemptState,
    args: {
        momentId: string;
        revisionId: string;
        request: Extract<SubmitTrainingAttemptRequest, { kind: 'START' }>;
    }
) {
    if (
        attempt.trainingMomentId !== args.momentId ||
        attempt.solutionRevisionId !== args.revisionId ||
        normalizeUci(attempt.userMoveUci ?? '') !== args.request.moveUci ||
        attempt.timeSpentMs !== (args.request.timeSpentMs ?? null)
    ) {
        throw new TrainingAttemptError(
            'clientAttemptId payload conflict',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
}

function assertIdempotentUserStep(
    step: {
        actor: 'USER' | 'ENGINE';
        moveUci: string;
        timeSpentMs: number | null;
    },
    request: Extract<SubmitTrainingAttemptRequest, { kind: 'STEP' }>
) {
    if (
        step.actor !== 'USER' ||
        normalizeUci(step.moveUci) !== request.moveUci ||
        step.timeSpentMs !== (request.timeSpentMs ?? null)
    ) {
        throw new TrainingAttemptError(
            'Continuation step payload conflict',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
}

function worstAcceptedGrade(grades: AttemptGrade[]): AttemptGrade {
    if (grades.some((grade) => grade === 'DIFFERENT_MISTAKE')) {
        return 'DIFFERENT_MISTAKE';
    }
    if (grades.some((grade) => grade === 'REPEATED_MISTAKE')) {
        return 'REPEATED_MISTAKE';
    }
    if (grades.some((grade) => grade === 'IMPROVED')) return 'IMPROVED';
    if (grades.some((grade) => grade === 'GOOD')) return 'GOOD';
    return 'BEST';
}

function tablebaseRank(wdl: 'WIN' | 'DRAW' | 'LOSS' | 'UNKNOWN'): number {
    if (wdl === 'WIN') return 2;
    if (wdl === 'DRAW') return 1;
    if (wdl === 'LOSS') return 0;
    return -1;
}

function stableEngineEvidence(args: {
    firstScore: PovScore | null;
    firstWdlChance: number | null;
    secondScore: PovScore | null;
    secondWdlChance: number | null;
    trainingSide: 'w' | 'b';
}): boolean {
    if (!args.firstScore || !args.secondScore) return false;
    if (
        args.firstScore.kind === 'mate' ||
        args.secondScore.kind === 'mate'
    ) {
        return (
            args.firstScore.kind === 'mate' &&
            args.secondScore.kind === 'mate' &&
            args.firstScore.winner === args.secondScore.winner
        );
    }
    if (
        args.firstScore.kind === 'tablebase' ||
        args.secondScore.kind === 'tablebase'
    ) {
        return (
            args.firstScore.kind === 'tablebase' &&
            args.secondScore.kind === 'tablebase' &&
            args.firstScore.wdl === args.secondScore.wdl
        );
    }
    const first = scoreForTrainingSide(
        args.firstScore,
        args.trainingSide
    );
    const second = scoreForTrainingSide(
        args.secondScore,
        args.trainingSide
    );
    const firstChance = args.firstWdlChance ?? first.chance;
    const secondChance = args.secondWdlChance ?? second.chance;
    if (firstChance != null && secondChance != null) {
        return Math.abs(firstChance - secondChance) <= 0.05;
    }
    return (
        first.cp != null &&
        second.cp != null &&
        Math.abs(first.cp - second.cp) <= 75
    );
}

function stableMatchedGap(args: {
    firstBestScore: PovScore | null;
    firstBestWdlChance: number | null;
    firstSubmittedScore: PovScore | null;
    firstSubmittedWdlChance: number | null;
    secondBestScore: PovScore | null;
    secondBestWdlChance: number | null;
    secondSubmittedScore: PovScore | null;
    secondSubmittedWdlChance: number | null;
    trainingSide: 'w' | 'b';
}): boolean {
    const allWdl = [
        args.firstBestWdlChance,
        args.firstSubmittedWdlChance,
        args.secondBestWdlChance,
        args.secondSubmittedWdlChance,
    ];
    if (
        allWdl.every(
            (value): value is number =>
                typeof value === 'number' &&
                Number.isFinite(value)
        )
    ) {
        const firstGap = Math.max(0, allWdl[0] - allWdl[1]);
        const secondGap = Math.max(0, allWdl[2] - allWdl[3]);
        return Math.abs(firstGap - secondGap) <= 0.05;
    }

    const firstBest = scoreForTrainingSide(
        args.firstBestScore,
        args.trainingSide
    );
    const firstSubmitted = scoreForTrainingSide(
        args.firstSubmittedScore,
        args.trainingSide
    );
    const secondBest = scoreForTrainingSide(
        args.secondBestScore,
        args.trainingSide
    );
    const secondSubmitted = scoreForTrainingSide(
        args.secondSubmittedScore,
        args.trainingSide
    );
    if (
        firstBest.cp != null &&
        firstSubmitted.cp != null &&
        secondBest.cp != null &&
        secondSubmitted.cp != null
    ) {
        const firstGap = Math.max(
            0,
            firstBest.cp - firstSubmitted.cp
        );
        const secondGap = Math.max(
            0,
            secondBest.cp - secondSubmitted.cp
        );
        return Math.abs(firstGap - secondGap) <= 75;
    }
    return (
        stableEngineEvidence({
            firstScore: args.firstBestScore,
            firstWdlChance: args.firstBestWdlChance,
            secondScore: args.secondBestScore,
            secondWdlChance: args.secondBestWdlChance,
            trainingSide: args.trainingSide,
        }) &&
        stableEngineEvidence({
            firstScore: args.firstSubmittedScore,
            firstWdlChance: args.firstSubmittedWdlChance,
            secondScore: args.secondSubmittedScore,
            secondWdlChance: args.secondSubmittedWdlChance,
            trainingSide: args.trainingSide,
        })
    );
}

type RuleTerminalOutcome = {
    reason:
        | 'CHECKMATE'
        | 'STALEMATE'
        | 'INSUFFICIENT_MATERIAL'
        | 'FIFTY_MOVE'
        | 'THREEFOLD_REPETITION';
    score: PovScore;
};

function ruleTerminalOutcome(args: {
    fen: string;
    positionHistory: string[];
}): RuleTerminalOutcome | null {
    const board = new Chess(args.fen);
    if (board.isCheckmate()) {
        return {
            reason: 'CHECKMATE',
            score: {
                kind: 'mate',
                plies: 0,
                winner:
                    board.turn() === 'w' ? 'BLACK' : 'WHITE',
            },
        };
    }
    const drawReason = board.isStalemate()
        ? 'STALEMATE'
        : board.isInsufficientMaterial()
          ? 'INSUFFICIENT_MATERIAL'
          : board.isDrawByFiftyMoves()
            ? 'FIFTY_MOVE'
            : null;
    if (drawReason) {
        return {
            reason: drawReason,
            score: {
                kind: 'tablebase',
                wdl: 'DRAW',
                pov: 'WHITE',
            },
        };
    }
    const key = board
        .fen()
        .split(/\s+/)
        .slice(0, 4)
        .join(' ');
    const repetitions = args.positionHistory.reduce(
        (count, historicalFen) => {
            try {
                const historicalKey = new Chess(historicalFen)
                    .fen()
                    .split(/\s+/)
                    .slice(0, 4)
                    .join(' ');
                return count + (historicalKey === key ? 1 : 0);
            } catch {
                return count;
            }
        },
        0
    );
    return repetitions >= 3
        ? {
              reason: 'THREEFOLD_REPETITION',
              score: {
                  kind: 'tablebase',
                  wdl: 'DRAW',
                  pov: 'WHITE',
              },
          }
        : null;
}

export async function evaluateDynamicTrainingMove(args: {
    fen: string;
    moveUci: string;
    trainingSide: 'w' | 'b';
    bestScore: PovScore | null;
    originalScore: PovScore | null;
    originalMoveUci: string;
    positionHistory?: string[];
}): Promise<DynamicEvaluation> {
    const fenAfter = applyUci(args.fen, args.moveUci);
    if (!fenAfter) throw new Error('Illegal move');
    const terminalOutcome = ruleTerminalOutcome({
        fen: fenAfter,
        positionHistory: [
            ...(args.positionHistory ?? []).slice(-256),
            args.fen,
            fenAfter,
        ],
    });
    if (!terminalOutcome) {
        let tablebaseEvidence: TablebaseEvidence | null = null;
        try {
            tablebaseEvidence = await dynamicTablebase.probe(args.fen);
        } catch {
            tablebaseEvidence = null;
        }
        const tablebaseMove = tablebaseEvidence?.moves.find(
            (move) =>
                normalizeUci(move.uci) ===
                    normalizeUci(args.moveUci) &&
                move.wdl !== 'UNKNOWN'
        );
        if (
            tablebaseMove &&
            tablebaseMove.wdl !== 'UNKNOWN' &&
            tablebaseEvidence
        ) {
            const best = tablebaseEvidence.moves
                .filter((move) => move.wdl !== 'UNKNOWN')
                .sort(
                    (left, right) =>
                        tablebaseRank(right.wdl) -
                        tablebaseRank(left.wdl)
                )[0];
            if (best && best.wdl !== 'UNKNOWN') {
                const submittedScore = trainingWdlToWhitePov(
                    tablebaseMove.wdl,
                    args.trainingSide,
                    tablebaseMove.dtz
                );
                const bestScore = trainingWdlToWhitePov(
                    best.wdl,
                    args.trainingSide,
                    best.dtz
                );
                return {
                    source: 'TABLEBASE',
                    scoreAfter: submittedScore,
                    metrics: metricsFromPovScores({
                        moveUci: args.moveUci,
                        originalMoveUci:
                            args.originalMoveUci,
                        trainingSide: args.trainingSide,
                        bestScore,
                        submittedScore,
                        originalScore: args.originalScore,
                    }),
                    evidence: {
                        source: 'LICHESS_SYZYGY',
                        root: tablebaseEvidence,
                        selected: tablebaseMove,
                    },
                };
            }
        }
    }
    const rootScorePov = new Chess(args.fen).turn();
    const submittedBoard = new Chess(fenAfter);
    const submittedScorePov = submittedBoard.turn();
    const engine = new ServerStockfishClient({
        defaultNodes: 140_000,
        defaultTimeoutMs: 15_000,
    });
    try {
        const firstBestEvaluation = await engine.evalPosition({
            fen: args.fen,
            nodes: 70_000,
            timeoutMs: 15_000,
        });
        if (terminalOutcome) {
            const bestEvaluation = await engine.evalPosition({
                fen: args.fen,
                nodes: 140_000,
                timeoutMs: 15_000,
            });
            const firstBestScore = engineScoreToWhitePov(
                firstBestEvaluation.score,
                rootScorePov
            );
            const bestScore = engineScoreToWhitePov(
                bestEvaluation.score,
                rootScorePov
            );
            const firstBestWdlChance = engineWdlChance(
                firstBestEvaluation.wdl,
                rootScorePov,
                args.trainingSide
            );
            const bestWdlChance = engineWdlChance(
                bestEvaluation.wdl,
                rootScorePov,
                args.trainingSide
            );
            const stable = stableEngineEvidence({
                firstScore: firstBestScore,
                firstWdlChance: firstBestWdlChance,
                secondScore: bestScore,
                secondWdlChance: bestWdlChance,
                trainingSide: args.trainingSide,
            });
            const metrics = metricsFromPovScores({
                moveUci: args.moveUci,
                originalMoveUci: args.originalMoveUci,
                trainingSide: args.trainingSide,
                bestScore,
                submittedScore: terminalOutcome.score,
                originalScore: args.originalScore,
            });
            metrics.stable = stable;
            return {
                source: 'DYNAMIC',
                scoreAfter: terminalOutcome.score,
                metrics,
                evidence: {
                    source: 'RULE',
                    fenAfter,
                    terminal: terminalOutcome.reason,
                    matchedRootPasses: [
                        {
                            nodesRequested: 70_000,
                            best: firstBestEvaluation,
                            bestWdlChance:
                                firstBestWdlChance,
                        },
                        {
                            nodesRequested: 140_000,
                            best: bestEvaluation,
                            bestWdlChance,
                        },
                    ],
                    stable,
                    identity: await engine.getIdentity(),
                },
            };
        }
        const firstSubmittedEvaluation = await engine.evalPosition({
            fen: fenAfter,
            nodes: 70_000,
            timeoutMs: 15_000,
        });
        const bestEvaluation = await engine.evalPosition({
            fen: args.fen,
            nodes: 140_000,
            timeoutMs: 15_000,
        });
        const submittedEvaluation = await engine.evalPosition({
            fen: fenAfter,
            nodes: 140_000,
            timeoutMs: 15_000,
        });
        const firstBestScore = engineScoreToWhitePov(
            firstBestEvaluation.score,
            rootScorePov
        );
        const firstSubmittedScore = engineScoreToWhitePov(
            firstSubmittedEvaluation.score,
            submittedScorePov
        );
        const bestScore = engineScoreToWhitePov(
            bestEvaluation.score,
            rootScorePov
        );
        const submittedScore = engineScoreToWhitePov(
            submittedEvaluation.score,
            submittedScorePov
        );
        const firstBestWdlChance = engineWdlChance(
            firstBestEvaluation.wdl,
            rootScorePov,
            args.trainingSide
        );
        const firstSubmittedWdlChance = engineWdlChance(
            firstSubmittedEvaluation.wdl,
            submittedScorePov,
            args.trainingSide
        );
        const bestWdlChance = engineWdlChance(
            bestEvaluation.wdl,
            rootScorePov,
            args.trainingSide
        );
        const submittedWdlChance = engineWdlChance(
            submittedEvaluation.wdl,
            submittedScorePov,
            args.trainingSide
        );
        const stable =
            stableEngineEvidence({
                firstScore: firstBestScore,
                firstWdlChance: firstBestWdlChance,
                secondScore: bestScore,
                secondWdlChance: bestWdlChance,
                trainingSide: args.trainingSide,
            }) &&
            stableEngineEvidence({
                firstScore: firstSubmittedScore,
                firstWdlChance: firstSubmittedWdlChance,
                secondScore: submittedScore,
                secondWdlChance: submittedWdlChance,
                trainingSide: args.trainingSide,
            }) &&
            stableMatchedGap({
                firstBestScore,
                firstBestWdlChance,
                firstSubmittedScore,
                firstSubmittedWdlChance,
                secondBestScore: bestScore,
                secondBestWdlChance: bestWdlChance,
                secondSubmittedScore: submittedScore,
                secondSubmittedWdlChance: submittedWdlChance,
                trainingSide: args.trainingSide,
            });
        const metrics = metricsFromMatchedOutcomeEvidence({
            moveUci: args.moveUci,
            originalMoveUci: args.originalMoveUci,
            trainingSide: args.trainingSide,
            bestScore,
            submittedScore,
            originalScore: args.originalScore,
            bestWdlChance,
            submittedWdlChance,
            stable,
        });
        return {
            source: 'DYNAMIC',
            scoreAfter: submittedScore,
            metrics,
            evidence: {
                source: 'STOCKFISH',
                fenAfter,
                matchedPasses: [
                    {
                        nodesRequested: 70_000,
                        best: firstBestEvaluation,
                        submitted: firstSubmittedEvaluation,
                        bestWdlChance: firstBestWdlChance,
                        submittedWdlChance:
                            firstSubmittedWdlChance,
                    },
                    {
                        nodesRequested: 140_000,
                        best: bestEvaluation,
                        submitted: submittedEvaluation,
                        bestWdlChance,
                        submittedWdlChance,
                    },
                ],
                stable,
                identity: await engine.getIdentity(),
            },
        };
    } finally {
        engine.terminate();
    }
}

async function gradeVerifiedAssessment(args: {
    db: TrainingWriteDb;
    revision: RevisionState;
    moment: AttemptState['trainingMoment'];
    fen: string;
    moveUci: string;
    decisionIndex: number;
    positionHistory: string[];
    userNode?: SolutionTreeNode | null;
}): Promise<AssessedMove | null> {
    const key = assessmentPositionKey(
        args.fen,
        args.positionHistory
    );
    const assessment =
        await args.db.solutionMoveAssessment.findUnique({
            where: {
                solutionRevisionId_decisionIndex_positionKey_moveUci: {
                    solutionRevisionId: args.revision.id,
                    decisionIndex: args.decisionIndex,
                    positionKey: key,
                    moveUci: args.moveUci,
                },
            },
        });
    if (!assessment || assessment.status !== 'VERIFIED') {
        return null;
    }
    // The replayed branch is authoritative. Searching by only FEN + ply is
    // ambiguous when two conditional lines transpose into the same position
    // with different repetition histories.
    const userNode =
        args.userNode ??
        (args.decisionIndex === 0
            ? parseTree(args.revision.solutionTree)
            : null);
    const bestMoveUci =
        userNode?.branches.find((branch) => branch.best)?.moveUci ??
        (args.decisionIndex === 0
            ? normalizeUci(args.revision.bestMoveUci)
            : null);
    const bestAssessment =
        bestMoveUci === normalizeUci(args.moveUci)
            ? assessment
            : bestMoveUci
              ? await args.db.solutionMoveAssessment.findUnique({
                    where: {
                        solutionRevisionId_decisionIndex_positionKey_moveUci: {
                            solutionRevisionId: args.revision.id,
                            decisionIndex: args.decisionIndex,
                            positionKey: key,
                            moveUci: bestMoveUci,
                        },
                    },
                })
              : null;
    const submittedScore = nullablePovScore(assessment.scoreAfter);
    const bestScore =
        (args.decisionIndex === 0
            ? nullablePovScore(args.revision.scoreAtStart)
            : nullablePovScore(bestAssessment?.scoreAfter)) ??
        nullablePovScore(args.revision.scoreAtStart);
    const metrics = metricsFromPovScores({
        moveUci: args.moveUci,
        originalMoveUci:
            args.decisionIndex === 0
                ? args.moment.originalMoveUci
                : '',
        trainingSide:
            args.moment.sideToMove === 'b' ? 'b' : 'w',
        bestScore,
        submittedScore,
        originalScore:
            args.decisionIndex === 0
                ? nullablePovScore(args.moment.scoreAfter)
                : null,
        evidence: assessment.evidence,
    });
    const repeatedOriginal =
        args.decisionIndex === 0 &&
        normalizeUci(args.moveUci) ===
            normalizeUci(args.moment.originalMoveUci);
    return {
        submittedScore,
        metrics,
        source: assessment.source,
        evidence: assessment.evidence,
        // Persisted grades describe the extractor/dynamic-cache decision that
        // produced this evidence. The pinned revision policy remains the
        // authority for the current attempt, so only the move-identity rule
        // can produce a result here without re-running the grader.
        ...(repeatedOriginal
            ? {
                  gradeResult: {
                      status: 'GRADED' as const,
                      grade: 'REPEATED_MISTAKE' as const,
                      accepted: false,
                  },
              }
            : {}),
    };
}

async function claimDynamicAssessment(args: {
    db: TrainingWriteDb;
    revisionId: string;
    fen: string;
    moveUci: string;
    decisionIndex: number;
    positionHistory: string[];
    userNode?: SolutionTreeNode | null;
    now: Date;
    forceRefreshVerified?: boolean;
}) {
    const key = assessmentPositionKey(
        args.fen,
        args.positionHistory
    );
    const uniqueWhere = {
        solutionRevisionId_decisionIndex_positionKey_moveUci: {
            solutionRevisionId: args.revisionId,
            decisionIndex: args.decisionIndex,
            positionKey: key,
            moveUci: args.moveUci,
        },
    };
    let assessment =
        await args.db.solutionMoveAssessment.findUnique({
            where: uniqueWhere,
        });
    if (!assessment) {
        try {
            assessment = await args.db.solutionMoveAssessment.create({
                data: {
                    solutionRevisionId: args.revisionId,
                    positionKey: key,
                    decisionIndex: args.decisionIndex,
                    fen: args.fen,
                    moveUci: args.moveUci,
                    source: 'DYNAMIC',
                    status: 'PENDING',
                    attempts: 1,
                    lockedAt: args.now,
                    lockedUntil: new Date(
                        args.now.getTime() + ASSESSMENT_LEASE_MS
                    ),
                    evidence: {},
                },
            });
            return {
                assessment,
                fence: {
                    lockedAt: args.now,
                    attempts: 1,
                },
            };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            assessment =
                await args.db.solutionMoveAssessment.findUnique({
                    where: uniqueWhere,
                });
        }
    }
    if (
        assessment?.status === 'VERIFIED' &&
        !args.forceRefreshVerified
    ) {
        return { assessment, fence: null };
    }
    if (!assessment) {
        throw new TrainingAttemptError(
            'Move assessment is unavailable',
            'GRADING_BUSY',
            429,
            ASSESSMENT_LEASE_MS
        );
    }
    const nextAttempts = assessment.attempts + 1;
    const claimed =
        await args.db.solutionMoveAssessment.updateMany({
            where: {
                id: assessment.id,
                status: {
                    in: args.forceRefreshVerified
                        ? ['PENDING', 'FAILED', 'VERIFIED']
                        : ['PENDING', 'FAILED'],
                },
                attempts: assessment.attempts,
                OR: [
                    { lockedUntil: null },
                    { lockedUntil: { lte: args.now } },
                ],
            },
            data: {
                status: 'PENDING',
                source: 'DYNAMIC',
                attempts: { increment: 1 },
                lockedAt: args.now,
                lockedUntil: new Date(
                    args.now.getTime() + ASSESSMENT_LEASE_MS
                ),
                lastError: null,
            },
        });
    if (claimed.count !== 1) {
        throw new TrainingAttemptError(
            'Move assessment is already being graded',
            'GRADING_BUSY',
            429,
            Math.max(
                250,
                (assessment.lockedUntil?.getTime() ??
                    args.now.getTime() + ASSESSMENT_LEASE_MS) -
                    args.now.getTime()
            )
        );
    }
    return {
        assessment: { ...assessment, attempts: nextAttempts },
        fence: {
            lockedAt: args.now,
            attempts: nextAttempts,
        },
    };
}

async function dynamicAssessment(args: {
    db: TrainingWriteDb;
    attemptId: string;
    revision: RevisionState;
    moment: AttemptState['trainingMoment'];
    fen: string;
    moveUci: string;
    decisionIndex: number;
    positionHistory: string[];
    userNode?: SolutionTreeNode | null;
    now: Date;
    evaluator: NonNullable<
        TrainingAttemptDependencies['evaluateDynamicMove']
    >;
    forceRefreshVerified?: boolean;
}): Promise<AssessedMove | null> {
    const recent = await args.db.trainingAttempt.count({
        where: {
            userId: args.moment.userId,
            gradingSource: 'DYNAMIC',
            attemptedAt: {
                gte: new Date(
                    args.now.getTime() - DYNAMIC_RATE_WINDOW_MS
                ),
            },
        },
    });
    if (recent >= DYNAMIC_RATE_LIMIT) {
        throw new TrainingAttemptError(
            'Dynamic grading rate limit exceeded',
            'RATE_LIMITED',
            429,
            DYNAMIC_RATE_WINDOW_MS
        );
    }
    await args.db.trainingAttempt.updateMany({
        where: {
            id: args.attemptId,
            status: 'PENDING',
            solutionRevisionId: args.revision.id,
        },
        data: { gradingSource: 'DYNAMIC' },
    });
    const claim = await claimDynamicAssessment({
        db: args.db,
        revisionId: args.revision.id,
        fen: args.fen,
        moveUci: args.moveUci,
        decisionIndex: args.decisionIndex,
        positionHistory: args.positionHistory,
        now: args.now,
        forceRefreshVerified: args.forceRefreshVerified,
    });
    if (claim.assessment.status === 'VERIFIED') {
        return gradeVerifiedAssessment({
            db: args.db,
            revision: args.revision,
            moment: args.moment,
            fen: args.fen,
            moveUci: args.moveUci,
            decisionIndex: args.decisionIndex,
            positionHistory: args.positionHistory,
            userNode: args.userNode,
        });
    }
    if (!claim.fence) return null;

    try {
        const evaluated = await args.evaluator({
            fen: args.fen,
            moveUci: args.moveUci,
            trainingSide:
                args.moment.sideToMove === 'b' ? 'b' : 'w',
            bestScore: nullablePovScore(args.revision.scoreAtStart),
            originalScore:
                args.decisionIndex === 0
                    ? nullablePovScore(args.moment.scoreAfter)
                    : null,
            originalMoveUci:
                args.decisionIndex === 0
                    ? args.moment.originalMoveUci
                    : '',
            positionHistory: args.positionHistory,
        });
        const policy = parseGradingPolicy(
            args.revision.gradingPolicy
        );
        if (!policy) throw new Error('Invalid grading policy');
        const gradeResult = gradeTrainingMove(
            evaluated.metrics,
            policy
        );
        if (gradeResult.status === 'UNRESOLVED') {
            const released =
                await args.db.solutionMoveAssessment.updateMany({
                    where: {
                        id: claim.assessment.id,
                        status: 'PENDING',
                        lockedAt: claim.fence.lockedAt,
                        attempts: claim.fence.attempts,
                    },
                    data: {
                        status: 'FAILED',
                        scoreAfter:
                            evaluated.scoreAfter == null
                                ? Prisma.DbNull
                                : json(evaluated.scoreAfter),
                        evidence: json({
                            ...assessmentEvidence(
                                evaluated.evidence
                            ),
                            gradeResult,
                        }),
                        lockedAt: null,
                        lockedUntil: null,
                        lastError: gradeResult.reason,
                    },
                });
            if (released.count !== 1) {
                throw new TrainingAttemptError(
                    'Dynamic grading lease was lost',
                    'GRADING_BUSY',
                    429,
                    500
                );
            }
            return {
                submittedScore: evaluated.scoreAfter,
                metrics: evaluated.metrics,
                source: evaluated.source,
                evidence: evaluated.evidence,
                gradeResult,
            };
        }
        const completed =
            await args.db.solutionMoveAssessment.updateMany({
                where: {
                    id: claim.assessment.id,
                    status: 'PENDING',
                    lockedAt: claim.fence.lockedAt,
                    attempts: claim.fence.attempts,
                },
                data: {
                    status: 'VERIFIED',
                    source: evaluated.source,
                    grade: gradeResult.grade,
                    scoreAfter:
                        evaluated.scoreAfter == null
                            ? Prisma.DbNull
                            : json(evaluated.scoreAfter),
                    evidence: json({
                        ...assessmentEvidence(evaluated.evidence),
                        bestGapCp:
                            evaluated.metrics.bestGapCp ?? null,
                        bestGapWinChance:
                            evaluated.metrics.bestGapWinChance ??
                            null,
                        recoveredCp:
                            evaluated.metrics.recoveredCp ?? null,
                        recoveredWinChance:
                            evaluated.metrics
                                .recoveredWinChance ?? null,
                        preservesOutcome:
                            evaluated.metrics.preservesOutcome ??
                            null,
                        gradeResult,
                    }),
                    lockedAt: null,
                    lockedUntil: null,
                    lastError: null,
                },
            });
        if (completed.count !== 1) {
            throw new TrainingAttemptError(
                'Dynamic grading lease was lost',
                'GRADING_BUSY',
                429,
                500
            );
        }
        return {
            submittedScore: evaluated.scoreAfter,
            metrics: evaluated.metrics,
            source: evaluated.source,
            evidence: evaluated.evidence,
            gradeResult,
        };
    } catch (error) {
        if (error instanceof TrainingAttemptError) throw error;
        await args.db.solutionMoveAssessment.updateMany({
            where: {
                id: claim.assessment.id,
                status: 'PENDING',
                lockedAt: claim.fence.lockedAt,
                attempts: claim.fence.attempts,
            },
            data: {
                status: 'FAILED',
                lockedAt: null,
                lockedUntil: null,
                lastError: (
                    error instanceof Error
                        ? error.message
                        : String(error)
                ).slice(0, 2_000),
            },
        });
        return null;
    }
}

async function finishUnresolved(args: {
    db: TrainingWriteDb;
    attemptId: string;
    stepId: string;
    reason:
        | 'ENGINE_UNAVAILABLE'
        | 'UNSTABLE_EVIDENCE'
        | 'MISSING_OUTCOME_EVIDENCE';
    now: Date;
    retryId?: string;
}): Promise<SubmitTrainingAttemptResponse> {
    await args.db.$transaction(async (tx) => {
        await tx.trainingAttemptStep.updateMany({
            where: {
                id: args.stepId,
                grade: null,
            },
            data: {
                evidence: { reason: args.reason },
            },
        });
        const attemptWrite = await tx.trainingAttempt.updateMany({
            where: {
                id: args.attemptId,
                status: 'PENDING',
            },
            data: {
                status: 'UNRESOLVED',
                gradingEvidence: {
                    reason: args.reason,
                    ...(args.retryId
                        ? { retryId: args.retryId }
                        : {}),
                },
                completedAt: args.now,
            },
        });
        if (attemptWrite.count !== 1) {
            throw new TrainingAttemptError(
                'Attempt changed while recording unresolved grading',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
    });
    return {
        attemptId: args.attemptId,
        status: 'UNRESOLVED',
        reason: args.reason,
    };
}

async function processPendingStep(args: {
    db: TrainingWriteDb;
    userId: string;
    attemptId: string;
    stepIndex: number;
    now: Date;
    evaluator: NonNullable<
        TrainingAttemptDependencies['evaluateDynamicMove']
    >;
    forceDynamic?: boolean;
    retryId?: string;
}): Promise<SubmitTrainingAttemptResponse> {
    const attempt = await loadAttempt(
        args.db,
        args.attemptId,
        args.userId
    );
    if (!attempt || attempt.status !== 'PENDING') {
        const response = attempt ? terminalResponse(attempt) : null;
        if (response) return response;
        throw new TrainingAttemptError(
            'Attempt is not pending',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
    const step = attempt.steps.find(
        (candidate) => candidate.stepIndex === args.stepIndex
    );
    if (!step || step.actor !== 'USER') {
        throw new TrainingAttemptError(
            'Continuation step is not current',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
    if (step.grade) {
        const response = awaitingResponse(attempt);
        if (response) return response;
    }
    const root = parseTree(attempt.solutionRevision.solutionTree);
    const node = nodeBeforeStep(root, attempt.steps, step.stepIndex);
    const fen = node?.fen ?? step.fenBefore;
    const decisionIndex = Math.floor(step.stepIndex / 2);
    const positionHistory = [
        ...attempt.trainingMoment.positionHistory,
        ...attempt.steps
            .filter(
                (previousStep) =>
                    previousStep.stepIndex < step.stepIndex
            )
            .map((previousStep) => previousStep.fenBefore),
    ].slice(-MAX_ASSESSMENT_POSITION_HISTORY);
    let assessed: AssessedMove | null = args.forceDynamic
        ? null
        : await gradeVerifiedAssessment({
              db: args.db,
              revision: attempt.solutionRevision,
              moment: attempt.trainingMoment,
              fen,
              moveUci: normalizeUci(step.moveUci),
              decisionIndex,
              positionHistory,
              userNode: node?.role === 'USER' ? node : null,
          });
    let gradeResult: TrainingMoveGradeResult | null = null;
    if (assessed) {
        gradeResult = assessed.gradeResult ?? null;
        const policy = parseGradingPolicy(
            attempt.solutionRevision.gradingPolicy
        );
        if (!gradeResult && !policy) {
            return finishUnresolved({
                db: args.db,
                attemptId: attempt.id,
                stepId: step.id,
                reason: 'MISSING_OUTCOME_EVIDENCE',
                now: args.now,
                retryId: args.retryId,
            });
        }
        if (!gradeResult && policy) {
            gradeResult = gradeTrainingMove(
                assessed.metrics,
                policy
            );
        }
    } else {
        const dynamic = await dynamicAssessment({
            db: args.db,
            attemptId: attempt.id,
            revision: attempt.solutionRevision,
            moment: attempt.trainingMoment,
            fen,
            moveUci: normalizeUci(step.moveUci),
            decisionIndex,
            positionHistory,
            userNode: node?.role === 'USER' ? node : null,
            now: args.now,
            evaluator: args.evaluator,
            forceRefreshVerified: args.forceDynamic,
        });
        if (!dynamic) {
            return finishUnresolved({
                db: args.db,
                attemptId: attempt.id,
                stepId: step.id,
                reason: 'ENGINE_UNAVAILABLE',
                now: args.now,
                retryId: args.retryId,
            });
        }
        assessed = dynamic;
        gradeResult = dynamic.gradeResult ?? null;
        if (!gradeResult) {
            const policy = parseGradingPolicy(
                attempt.solutionRevision.gradingPolicy
            );
            gradeResult = policy
                ? gradeTrainingMove(dynamic.metrics, policy)
                : {
                      status: 'UNRESOLVED',
                      reason: 'MISSING_OUTCOME_EVIDENCE',
                  };
        }
    }
    if (!gradeResult) {
        return finishUnresolved({
            db: args.db,
            attemptId: attempt.id,
            stepId: step.id,
            reason: 'MISSING_OUTCOME_EVIDENCE',
            now: args.now,
            retryId: args.retryId,
        });
    }
    if (gradeResult.status === 'UNRESOLVED') {
        return finishUnresolved({
            db: args.db,
            attemptId: attempt.id,
            stepId: step.id,
            reason: gradeResult.reason,
            now: args.now,
            retryId: args.retryId,
        });
    }
    if (!assessed) {
        return finishUnresolved({
            db: args.db,
            attemptId: attempt.id,
            stepId: step.id,
            reason: 'MISSING_OUTCOME_EVIDENCE',
            now: args.now,
            retryId: args.retryId,
        });
    }

    const branch = node?.branches.find(
        (candidate) =>
            candidate.moveUci === normalizeUci(step.moveUci)
    );
    let opponentMove: TrainingOpponentMoveDto | null = null;
    let engineStep:
        | {
              stepIndex: number;
              fenBefore: string;
              moveUci: string;
              fenAfter: string;
          }
        | null = null;
    if (
        gradeResult.accepted &&
        branch?.child.role === 'OPPONENT' &&
        branch.child.branches.length > 0
    ) {
        const opponentBranch =
            branch.child.branches.find(
                (candidate) =>
                    candidate.moveUci ===
                    normalizeUci(
                        branch.child.selectedMoveUci ?? ''
                    )
            ) ??
            branch.child.branches.find((candidate) => candidate.best) ??
            branch.child.branches[0]!;
        engineStep = {
            stepIndex: step.stepIndex + 1,
            fenBefore: branch.child.fen,
            moveUci: opponentBranch.moveUci,
            fenAfter: opponentBranch.child.fen,
        };
        opponentMove = {
            moveUci: engineStep.moveUci,
            fenAfter: engineStep.fenAfter,
        };
    }

    const priorGrades = attempt.steps
        .filter(
            (candidate) =>
                candidate.actor === 'USER' &&
                candidate.stepIndex < step.stepIndex &&
                candidate.grade
        )
        .map((candidate) => candidate.grade as AttemptGrade);
    const aggregateGrade = worstAcceptedGrade([
        ...priorGrades,
        gradeResult.grade,
    ]);
    const shouldContinue =
        !!engineStep &&
        branch?.child.branches
            .find(
                (candidate) =>
                    candidate.moveUci === engineStep?.moveUci
            )
            ?.child.role === 'USER';
    const comparison = comparisonFromMetrics(
        assessed.submittedScore,
        assessed.metrics
    );
    const wroteGrade = await args.db.$transaction(async (tx) => {
        const stepWrite = await tx.trainingAttemptStep.updateMany({
            where: {
                id: step.id,
                grade: null,
            },
            data: {
                grade: gradeResult.grade,
                evidence: json({
                    source: assessed.source,
                    comparison,
                    assessment: assessed.evidence,
                }),
            },
        });
        if (stepWrite.count !== 1) {
            return false;
        }
        if (engineStep) {
            await tx.trainingAttemptStep.create({
                data: {
                    attemptId: attempt.id,
                    stepIndex: engineStep.stepIndex,
                    actor: 'ENGINE',
                    fenBefore: engineStep.fenBefore,
                    moveUci: engineStep.moveUci,
                    evidence: {
                        fenAfter: engineStep.fenAfter,
                    },
                },
            });
        }
        const attemptWrite = await tx.trainingAttempt.updateMany({
            where: {
                id: attempt.id,
                status: 'PENDING',
                solutionRevisionId: attempt.solutionRevisionId,
            },
            data: {
                ...(shouldContinue
                    ? {}
                    : {
                          status: 'GRADED',
                          grade: aggregateGrade,
                          completedAt: args.now,
                      }),
                gradingSource: assessed.source,
                gradingEvidence: json({
                    submittedScoreAfter: assessed.submittedScore,
                    preservesOutcome:
                        assessed.metrics.preservesOutcome ?? null,
                    source: assessed.source,
                }),
                bestGapCp:
                    assessed.metrics.bestGapCp == null
                        ? null
                        : Math.round(assessed.metrics.bestGapCp),
                bestGapWinChance:
                    assessed.metrics.bestGapWinChance ?? null,
                recoveredCp:
                    assessed.metrics.recoveredCp == null
                        ? null
                        : Math.round(assessed.metrics.recoveredCp),
                recoveredWinChance:
                    assessed.metrics.recoveredWinChance ?? null,
            },
        });
        if (attemptWrite.count !== 1) {
            throw new TrainingAttemptError(
                'Attempt changed while grading',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        if (!shouldContinue) {
            await tx.trainingMoment.updateMany({
                where: {
                    id: attempt.trainingMomentId,
                    userId: args.userId,
                    status: 'ACTIVE',
                },
                data: { lastTrainedAt: args.now },
            });
        }
        return true;
    });
    if (!wroteGrade) {
        const winner = await loadAttempt(
            args.db,
            attempt.id,
            args.userId
        );
        const winnerStep = winner?.steps.find(
            (candidate) =>
                candidate.stepIndex === step.stepIndex
        );
        if (
            !winner ||
            !winnerStep ||
            winnerStep.actor !== 'USER' ||
            normalizeUci(winnerStep.moveUci) !==
                normalizeUci(step.moveUci) ||
            winnerStep.timeSpentMs !== step.timeSpentMs
        ) {
            throw new TrainingAttemptError(
                'Continuation step payload conflict',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        const winnerResponse = terminalResponse(winner);
        if (winnerResponse) return winnerResponse;
        throw new TrainingAttemptError(
            'Concurrent grading result is unavailable',
            'GRADING_BUSY',
            429,
            500
        );
    }

    if (shouldContinue && opponentMove && engineStep) {
        return {
            attemptId: attempt.id,
            status: 'AWAITING_CONTINUATION',
            nextStepIndex: engineStep.stepIndex + 1,
            opponentMove,
        };
    }
    const completed = await loadAttempt(args.db, attempt.id, args.userId);
    const response = completed ? terminalResponse(completed) : null;
    if (!response) throw new Error('Completed attempt could not be loaded');
    return response;
}

async function createStartAttempt(args: {
    db: TrainingWriteDb;
    userId: string;
    moment: StartMoment;
    request: Extract<SubmitTrainingAttemptRequest, { kind: 'START' }>;
    now: Date;
}) {
    await args.db.trainingAttempt.updateMany({
        where: {
            userId: args.userId,
            status: 'PENDING',
            attemptedAt: {
                lte: new Date(
                    args.now.getTime() -
                        STALE_PENDING_ATTEMPT_MS
                ),
            },
        },
        data: {
            status: 'UNRESOLVED',
            gradingEvidence: {
                reason: 'ENGINE_UNAVAILABLE',
                recovery: 'STALE_PENDING_ATTEMPT',
            },
            completedAt: args.now,
        },
    });
    try {
        return await args.db.$transaction(async (tx) => {
            const attempt = await tx.trainingAttempt.create({
                data: {
                    trainingMomentId: args.moment.id,
                    userId: args.userId,
                    solutionRevisionId:
                        args.request.solutionRevisionId,
                    clientAttemptId: args.request.clientAttemptId,
                    userMoveUci: args.request.moveUci,
                    timeSpentMs: args.request.timeSpentMs ?? null,
                    status: 'PENDING',
                    gradingEvidence: {},
                },
                select: { id: true },
            });
            await tx.trainingAttemptStep.create({
                data: {
                    attemptId: attempt.id,
                    stepIndex: 0,
                    actor: 'USER',
                    fenBefore: args.moment.fen,
                    moveUci: args.request.moveUci,
                    timeSpentMs: args.request.timeSpentMs ?? null,
                    evidence: {},
                },
            });
            return attempt;
        });
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing =
            await args.db.trainingAttempt.findUnique({
                where: {
                    userId_clientAttemptId: {
                        userId: args.userId,
                        clientAttemptId:
                            args.request.clientAttemptId,
                    },
                },
                select: attemptSelect,
            });
        if (existing) {
            assertIdempotentStart(existing, {
                momentId: args.moment.id,
                revisionId: args.request.solutionRevisionId,
                request: args.request,
            });
            return { id: existing.id };
        }
        throw new TrainingAttemptError(
            'Another attempt is awaiting grading',
            'GRADING_BUSY',
            429,
            ASSESSMENT_LEASE_MS
        );
    }
}

export async function submitTrainingAttempt(args: {
    userId: string;
    momentId: string;
    request: SubmitTrainingAttemptRequest;
    dependencies: TrainingAttemptDependencies;
}): Promise<SubmitTrainingAttemptResponse> {
    const db = args.dependencies.db;
    const now = args.dependencies.now?.() ?? new Date();
    const evaluator =
        args.dependencies.evaluateDynamicMove ??
        evaluateDynamicTrainingMove;

    if (args.request.kind === 'START') {
        const existing =
            await db.trainingAttempt.findUnique({
                where: {
                    userId_clientAttemptId: {
                        userId: args.userId,
                        clientAttemptId:
                            args.request.clientAttemptId,
                    },
                },
                select: attemptSelect,
            });
        if (existing) {
            assertIdempotentStart(existing, {
                momentId: args.momentId,
                revisionId: args.request.solutionRevisionId,
                request: args.request,
            });
            const response = terminalResponse(existing);
            if (response) return response;
            const pendingStep = existing.steps.find(
                (step) =>
                    step.actor === 'USER' && step.grade === null
            );
            if (pendingStep) {
                return processPendingStep({
                    db,
                    userId: args.userId,
                    attemptId: existing.id,
                    stepIndex: pendingStep.stepIndex,
                    now,
                    evaluator,
                });
            }
        }

        const moment = await db.trainingMoment.findFirst({
            where: {
                id: args.momentId,
                userId: args.userId,
                status: 'ACTIVE',
                archivedAt: null,
            },
            select: startMomentSelect,
        });
        if (!moment?.currentSolutionRevision) {
            throw new TrainingAttemptError(
                'Training moment not found',
                'NOT_FOUND',
                404
            );
        }
        if (
            moment.currentSolutionRevisionId !==
            args.request.solutionRevisionId
        ) {
            throw new TrainingAttemptError(
                'Training solution changed; reload the prompt',
                'STALE_REVISION',
                409
            );
        }
        if (
            !moment.currentSolutionRevision.trainable ||
            (moment.currentSolutionRevision.verificationStatus !==
                'VERIFIED' &&
                moment.currentSolutionRevision.verificationStatus !==
                    'AMBIGUOUS')
        ) {
            throw new TrainingAttemptError(
                'Training moment is not currently trainable',
                'NOT_FOUND',
                404
            );
        }
        if (!applyUci(moment.fen, args.request.moveUci)) {
            throw new TrainingAttemptError(
                'Illegal move',
                'ILLEGAL_MOVE',
                400
            );
        }
        const attempt = await createStartAttempt({
            db,
            userId: args.userId,
            moment,
            request: args.request,
            now,
        });
        return processPendingStep({
            db,
            userId: args.userId,
            attemptId: attempt.id,
            stepIndex: 0,
            now,
            evaluator,
        });
    }

    if (args.request.kind === 'RETRY') {
        const retryRequest = args.request;
        const attempt = await loadAttempt(
            db,
            retryRequest.attemptId,
            args.userId
        );
        if (
            !attempt ||
            attempt.trainingMomentId !== args.momentId
        ) {
            throw new TrainingAttemptError(
                'Training attempt not found',
                'NOT_FOUND',
                404
            );
        }
        if (
            attempt.clientAttemptId !==
            retryRequest.clientAttemptId
        ) {
            throw new TrainingAttemptError(
                'clientAttemptId payload conflict',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        const terminal = terminalResponse(attempt);
        if (attempt.status !== 'UNRESOLVED') {
            if (terminal) return terminal;
            throw new TrainingAttemptError(
                'Training attempt is already being graded',
                'GRADING_BUSY',
                429,
                500
            );
        }
        const unresolvedEvidence = assessmentEvidence(
            attempt.gradingEvidence
        );
        if (unresolvedEvidence.retryId === retryRequest.retryId) {
            if (terminal) return terminal;
            throw new TrainingAttemptError(
                'Retry result is unavailable',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        const retryStep = attempt.steps.find(
            (step) =>
                step.stepIndex === retryRequest.stepIndex &&
                step.actor === 'USER' &&
                step.grade === null
        );
        if (!retryStep) {
            throw new TrainingAttemptError(
                'Retry step is stale',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        let claimed;
        try {
            claimed = await db.trainingAttempt.updateMany({
                where: {
                    id: attempt.id,
                    userId: args.userId,
                    status: 'UNRESOLVED',
                    solutionRevisionId:
                        attempt.solutionRevisionId,
                },
                data: {
                    status: 'PENDING',
                    gradingEvidence: {
                        retryId: retryRequest.retryId,
                        state: 'PENDING',
                    },
                    completedAt: null,
                },
            });
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            throw new TrainingAttemptError(
                'Another attempt is awaiting grading',
                'GRADING_BUSY',
                429,
                500
            );
        }
        if (claimed.count !== 1) {
            const winner = await loadAttempt(
                db,
                attempt.id,
                args.userId
            );
            const response = winner
                ? terminalResponse(winner)
                : null;
            if (response) return response;
            throw new TrainingAttemptError(
                'Training attempt is already being graded',
                'GRADING_BUSY',
                429,
                500
            );
        }
        return processPendingStep({
            db,
            userId: args.userId,
            attemptId: attempt.id,
            stepIndex: retryRequest.stepIndex,
            now,
            evaluator,
            forceDynamic: true,
            retryId: retryRequest.retryId,
        });
    }

    const stepRequest = args.request;
    const attempt = await loadAttempt(
        db,
        stepRequest.attemptId,
        args.userId
    );
    if (
        !attempt ||
        attempt.trainingMomentId !== args.momentId
    ) {
        throw new TrainingAttemptError(
            'Training attempt not found',
            'NOT_FOUND',
            404
        );
    }
    if (attempt.clientAttemptId !== stepRequest.clientAttemptId) {
        throw new TrainingAttemptError(
            'clientAttemptId payload conflict',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
    const existingStep = attempt.steps.find(
        (step) => step.stepIndex === stepRequest.stepIndex
    );
    if (existingStep) {
        assertIdempotentUserStep(existingStep, stepRequest);
        const response = terminalResponse(attempt);
        if (response) return response;
        return processPendingStep({
            db,
            userId: args.userId,
            attemptId: attempt.id,
            stepIndex: existingStep.stepIndex,
            now,
            evaluator,
        });
    }
    if (
        attempt.status !== 'PENDING' ||
        stepRequest.stepIndex !== attempt.steps.length
    ) {
        throw new TrainingAttemptError(
            'Continuation step is stale',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
    const root = parseTree(attempt.solutionRevision.solutionTree);
    const node = nodeBeforeStep(
        root,
        attempt.steps,
        stepRequest.stepIndex
    );
    const fen =
        node?.role === 'USER'
            ? node.fen
            : applyUci(
                  attempt.steps.at(-1)?.fenBefore ??
                      attempt.trainingMoment.fen,
                  attempt.steps.at(-1)?.moveUci ?? ''
              );
    if (!fen || !applyUci(fen, stepRequest.moveUci)) {
        throw new TrainingAttemptError(
            'Illegal move',
            'ILLEGAL_MOVE',
            400
        );
    }
    try {
        await db.$transaction(async (tx) => {
            await tx.trainingAttemptStep.create({
                data: {
                    attemptId: attempt.id,
                    stepIndex: stepRequest.stepIndex,
                    actor: 'USER',
                    fenBefore: fen,
                    moveUci: stepRequest.moveUci,
                    timeSpentMs: stepRequest.timeSpentMs ?? null,
                    evidence: {},
                },
            });
            if (stepRequest.timeSpentMs != null) {
                const updated =
                    await tx.trainingAttempt.updateMany({
                        where: {
                            id: attempt.id,
                            status: 'PENDING',
                        },
                        data: {
                            timeSpentMs: {
                                increment:
                                    stepRequest.timeSpentMs,
                            },
                        },
                    });
                if (updated.count !== 1) {
                    throw new TrainingAttemptError(
                        'Attempt changed while adding a step',
                        'IDEMPOTENCY_CONFLICT',
                        409
                    );
                }
            }
        });
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winnerStep =
            await db.trainingAttemptStep.findUnique({
                where: {
                    attemptId_stepIndex: {
                        attemptId: attempt.id,
                        stepIndex: stepRequest.stepIndex,
                    },
                },
                select: {
                    actor: true,
                    moveUci: true,
                    timeSpentMs: true,
                },
            });
        if (!winnerStep) {
            throw new TrainingAttemptError(
                'Continuation step conflict could not be resolved',
                'IDEMPOTENCY_CONFLICT',
                409
            );
        }
        assertIdempotentUserStep(winnerStep, stepRequest);
    }
    return processPendingStep({
        db,
        userId: args.userId,
        attemptId: attempt.id,
        stepIndex: stepRequest.stepIndex,
        now,
        evaluator,
    });
}

function assertIdempotentReveal(
    attempt: AttemptState,
    args: {
        momentId: string;
        revisionId: string;
    }
): RevealTrainingMomentResponse {
    if (
        attempt.trainingMomentId !== args.momentId ||
        attempt.solutionRevisionId !== args.revisionId ||
        attempt.status !== 'REVEALED' ||
        attempt.userMoveUci !== null
    ) {
        throw new TrainingAttemptError(
            'clientAttemptId payload conflict',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
    return {
        attemptId: attempt.id,
        status: 'REVEALED',
        review: reviewForAttempt(attempt),
    };
}

export async function revealTrainingMoment(args: {
    userId: string;
    momentId: string;
    request: RevealTrainingMomentRequest;
    dependencies: Pick<TrainingAttemptDependencies, 'db' | 'now'>;
}): Promise<RevealTrainingMomentResponse> {
    const db = args.dependencies.db;
    const existing = await db.trainingAttempt.findUnique({
        where: {
            userId_clientAttemptId: {
                userId: args.userId,
                clientAttemptId: args.request.clientAttemptId,
            },
        },
        select: attemptSelect,
    });
    if (existing) {
        return assertIdempotentReveal(existing, {
            momentId: args.momentId,
            revisionId: args.request.solutionRevisionId,
        });
    }

    const moment = await db.trainingMoment.findFirst({
        where: {
            id: args.momentId,
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
        },
        select: startMomentSelect,
    });
    if (!moment?.currentSolutionRevision) {
        throw new TrainingAttemptError(
            'Training moment not found',
            'NOT_FOUND',
            404
        );
    }
    if (
        moment.currentSolutionRevisionId !==
        args.request.solutionRevisionId
    ) {
        throw new TrainingAttemptError(
            'Training solution changed; reload the prompt',
            'STALE_REVISION',
            409
        );
    }

    const now = args.dependencies.now?.() ?? new Date();
    try {
        const created = await db.$transaction(async (tx) => {
            const attempt = await tx.trainingAttempt.create({
                data: {
                    trainingMomentId: moment.id,
                    userId: args.userId,
                    solutionRevisionId:
                        args.request.solutionRevisionId,
                    clientAttemptId:
                        args.request.clientAttemptId,
                    userMoveUci: null,
                    status: 'REVEALED',
                    gradingEvidence: {
                        reason: 'USER_REVEAL',
                    },
                    completedAt: now,
                },
                select: attemptSelect,
            });
            await tx.trainingMoment.updateMany({
                where: {
                    id: moment.id,
                    userId: args.userId,
                    status: 'ACTIVE',
                },
                data: { lastTrainedAt: now },
            });
            return attempt;
        });
        return {
            attemptId: created.id,
            status: 'REVEALED',
            review: reviewForAttempt(created),
        };
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await db.trainingAttempt.findUnique({
            where: {
                userId_clientAttemptId: {
                    userId: args.userId,
                    clientAttemptId: args.request.clientAttemptId,
                },
            },
            select: attemptSelect,
        });
        if (raced) {
            return assertIdempotentReveal(raced, {
                momentId: args.momentId,
                revisionId: args.request.solutionRevisionId,
            });
        }
        throw new TrainingAttemptError(
            'Reveal could not be recorded',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
}
