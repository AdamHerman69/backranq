import { Chess } from 'chess.js';

import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import type {
    TrainingComparisonDto,
    TrainingGradingManifestDto,
    TrainingMoveAssessmentDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import type { AttemptGrade, PovScore } from '@/lib/training/contracts';
import {
    engineScoreToWhitePov,
    engineWdlChance,
    metricsFromMatchedOutcomeEvidence,
    metricsFromPovScores,
    scoreForTrainingSide,
} from '@/lib/training/gradingEvidence';
import {
    gradeTrainingMove,
    type TrainingMoveGradeResult,
    type TrainingMoveMetrics,
} from '@/lib/training/grader';

const FIRST_PASS_NODES = 70_000;
const CONFIRMATION_PASS_NODES = 140_000;
const LOCAL_ENGINE_TIMEOUT_MS = 20_000;

export type LocalMoveEvaluation = {
    result: TrainingMoveGradeResult;
    source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    scoreAfter: PovScore | null;
    comparison: TrainingComparisonDto | null;
    evidence: unknown;
};

export type LocalContinuation = {
    opponentMoveUci: string;
    fenAfterOpponentMove: string;
    nextUserNode: TrainingSolutionTreeNodeDto;
};

function normalizeUci(move: string): string {
    return move.trim().toLowerCase();
}

function applyUci(fen: string, moveUci: string): string | null {
    const move = normalizeUci(moveUci);
    try {
        const chess = new Chess(fen);
        const played = chess.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.slice(4, 5) || undefined,
        });
        return played ? chess.fen() : null;
    } catch {
        return null;
    }
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

function assessmentForMove(args: {
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
}): TrainingMoveAssessmentDto | null {
    const move = normalizeUci(args.moveUci);
    const decisionIndex = Math.floor(args.node.ply / 2);
    return (
        args.manifest.moveAssessments.find(
            (assessment) =>
                assessment.decisionIndex === decisionIndex &&
                assessment.fen === args.node.fen &&
                normalizeUci(assessment.moveUci) === move
        ) ?? null
    );
}

function bestAssessment(args: {
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
}): TrainingMoveAssessmentDto | null {
    const bestMove =
        args.node.branches.find((branch) => branch.best)?.moveUci ??
        args.node.selectedMoveUci ??
        args.node.acceptedMovesUci[0] ??
        '';
    return assessmentForMove({
        ...args,
        moveUci: bestMove,
    });
}

function knownMetrics(args: {
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
    assessment: TrainingMoveAssessmentDto | null;
}): TrainingMoveMetrics {
    const rootDecision = args.node.ply === 0;
    const bestScore =
        rootDecision
            ? args.manifest.review.scoreAtStart
            : bestAssessment(args)?.scoreAfter ??
              args.manifest.review.scoreAtStart;
    return metricsFromPovScores({
        moveUci: args.moveUci,
        originalMoveUci: rootDecision
            ? args.manifest.originalMoveUci
            : '',
        trainingSide: args.manifest.trainingSide,
        bestScore,
        submittedScore:
            args.assessment?.scoreAfter ??
            (rootDecision &&
            normalizeUci(args.moveUci) ===
                normalizeUci(args.manifest.originalMoveUci)
                ? args.manifest.originalScoreAfter
                : null),
        originalScore: rootDecision
            ? args.manifest.originalScoreAfter
            : null,
        evidence: args.assessment?.evidence,
    });
}

/**
 * Synchronous path used for every move already present in the downloaded
 * grading manifest. Returning null means "genuinely unknown", never "wrong".
 */
export function gradeKnownLocalMove(args: {
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
}): LocalMoveEvaluation | null {
    const move = normalizeUci(args.moveUci);
    const isRoot = args.node.ply === 0;
    const repeatedOriginal =
        isRoot &&
        move === normalizeUci(args.manifest.originalMoveUci);
    const assessment = assessmentForMove({
        ...args,
        moveUci: move,
    });
    const acceptedByTree = args.node.acceptedMovesUci.some(
        (accepted) => normalizeUci(accepted) === move
    );
    const branch = args.node.branches.find(
        (candidate) => normalizeUci(candidate.moveUci) === move
    );

    if (
        !repeatedOriginal &&
        !assessment &&
        !acceptedByTree &&
        !branch
    ) {
        return null;
    }

    const metrics = knownMetrics({
        ...args,
        moveUci: move,
        assessment,
    });
    const scoreAfter =
        assessment?.scoreAfter ??
        (repeatedOriginal
            ? args.manifest.originalScoreAfter
            : null);
    const grade =
        repeatedOriginal
            ? 'REPEATED_MISTAKE'
            : assessment?.grade ??
              (branch?.best ? 'BEST' : 'GOOD');
    const accepted = grade === 'BEST' || grade === 'GOOD';

    return {
        result: {
            status: 'GRADED',
            grade,
            accepted,
        },
        source: assessment?.source ?? 'PRECOMPUTED',
        scoreAfter,
        comparison:
            metrics.stable || repeatedOriginal
                ? comparisonFromMetrics(scoreAfter, metrics)
                : null,
        evidence: {
            kind: repeatedOriginal
                ? 'ORIGINAL_MOVE_IDENTITY'
                : 'DOWNLOADED_ASSESSMENT',
            assessment: assessment?.evidence ?? null,
        },
    };
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

function positionKey(fen: string): string {
    return new Chess(fen).fen().split(/\s+/).slice(0, 4).join(' ');
}

function terminalOutcome(args: {
    fen: string;
    positionHistory: readonly string[];
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
    const target = positionKey(args.fen);
    const repeats = args.positionHistory.reduce((count, fen) => {
        try {
            return count + (positionKey(fen) === target ? 1 : 0);
        } catch {
            return count;
        }
    }, 0);
    return repeats >= 3
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
    const wdl = [
        args.firstBestWdlChance,
        args.firstSubmittedWdlChance,
        args.secondBestWdlChance,
        args.secondSubmittedWdlChance,
    ];
    if (
        wdl.every(
            (value): value is number =>
                typeof value === 'number' && Number.isFinite(value)
        )
    ) {
        return (
            Math.abs(
                Math.max(0, wdl[0] - wdl[1]) -
                    Math.max(0, wdl[2] - wdl[3])
            ) <= 0.05
        );
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
        return (
            Math.abs(
                Math.max(0, firstBest.cp - firstSubmitted.cp) -
                    Math.max(0, secondBest.cp - secondSubmitted.cp)
            ) <= 75
        );
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

/**
 * Browser-only fallback for a legal move that was not precomputed. The same
 * Stockfish worker instance is reused by the caller, so root probes are cached
 * across alternatives and no network request participates in grading.
 */
export async function gradeUnknownLocalMove(args: {
    engine: StockfishEngine;
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
    positionHistory?: readonly string[];
}): Promise<LocalMoveEvaluation> {
    const move = normalizeUci(args.moveUci);
    const fenAfter = applyUci(args.node.fen, move);
    if (!fenAfter) throw new Error('Illegal move');

    const history = [
        ...(args.positionHistory ??
            args.manifest.positionHistory).slice(-256),
        args.node.fen,
        fenAfter,
    ];
    const terminal = terminalOutcome({
        fen: fenAfter,
        positionHistory: history,
    });
    const rootScorePov = new Chess(args.node.fen).turn();
    const submittedScorePov = new Chess(fenAfter).turn();
    const firstBest = await args.engine.evalPosition({
        fen: args.node.fen,
        nodes: FIRST_PASS_NODES,
        timeoutMs: LOCAL_ENGINE_TIMEOUT_MS,
    });
    const firstSubmitted = terminal
        ? null
        : await args.engine.evalPosition({
              fen: fenAfter,
              nodes: FIRST_PASS_NODES,
              timeoutMs: LOCAL_ENGINE_TIMEOUT_MS,
          });
    const confirmedBest = await args.engine.evalPosition({
        fen: args.node.fen,
        nodes: CONFIRMATION_PASS_NODES,
        timeoutMs: LOCAL_ENGINE_TIMEOUT_MS,
    });
    const confirmedSubmitted = terminal
        ? null
        : await args.engine.evalPosition({
              fen: fenAfter,
              nodes: CONFIRMATION_PASS_NODES,
              timeoutMs: LOCAL_ENGINE_TIMEOUT_MS,
          });

    const firstBestScore = engineScoreToWhitePov(
        firstBest.score,
        rootScorePov
    );
    const bestScore = engineScoreToWhitePov(
        confirmedBest.score,
        rootScorePov
    );
    const firstSubmittedScore =
        terminal?.score ??
        engineScoreToWhitePov(
            firstSubmitted?.score ?? null,
            submittedScorePov
        );
    const submittedScore =
        terminal?.score ??
        engineScoreToWhitePov(
            confirmedSubmitted?.score ?? null,
            submittedScorePov
        );
    const firstBestWdlChance = engineWdlChance(
        firstBest.wdl,
        rootScorePov,
        args.manifest.trainingSide
    );
    const bestWdlChance = engineWdlChance(
        confirmedBest.wdl,
        rootScorePov,
        args.manifest.trainingSide
    );
    const firstSubmittedWdlChance = terminal
        ? scoreForTrainingSide(
              terminal.score,
              args.manifest.trainingSide
          ).chance
        : engineWdlChance(
              firstSubmitted?.wdl,
              submittedScorePov,
              args.manifest.trainingSide
          );
    const submittedWdlChance = terminal
        ? firstSubmittedWdlChance
        : engineWdlChance(
              confirmedSubmitted?.wdl,
              submittedScorePov,
              args.manifest.trainingSide
          );
    const stable =
        stableEngineEvidence({
            firstScore: firstBestScore,
            firstWdlChance: firstBestWdlChance,
            secondScore: bestScore,
            secondWdlChance: bestWdlChance,
            trainingSide: args.manifest.trainingSide,
        }) &&
        stableEngineEvidence({
            firstScore: firstSubmittedScore,
            firstWdlChance: firstSubmittedWdlChance,
            secondScore: submittedScore,
            secondWdlChance: submittedWdlChance,
            trainingSide: args.manifest.trainingSide,
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
            trainingSide: args.manifest.trainingSide,
        });
    const rootDecision = args.node.ply === 0;
    const metrics = metricsFromMatchedOutcomeEvidence({
        moveUci: move,
        originalMoveUci: rootDecision
            ? args.manifest.originalMoveUci
            : '',
        trainingSide: args.manifest.trainingSide,
        bestScore,
        submittedScore,
        originalScore: rootDecision
            ? args.manifest.originalScoreAfter
            : null,
        bestWdlChance,
        submittedWdlChance,
        stable,
    });
    const result = gradeTrainingMove(
        metrics,
        args.manifest.gradingPolicy
    );
    return {
        result,
        source: 'DYNAMIC',
        scoreAfter: submittedScore,
        comparison: comparisonFromMetrics(
            submittedScore,
            metrics
        ),
        evidence: {
            kind: terminal ? 'LOCAL_RULE' : 'LOCAL_STOCKFISH',
            terminal: terminal?.reason ?? null,
            stable,
            passes: [
                {
                    nodes: FIRST_PASS_NODES,
                    best: firstBest,
                    submitted: firstSubmitted,
                },
                {
                    nodes: CONFIRMATION_PASS_NODES,
                    best: confirmedBest,
                    submitted: confirmedSubmitted,
                },
            ],
        },
    };
}

export function localContinuationForMove(args: {
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
}): LocalContinuation | null {
    const branch = args.node.branches.find(
        (candidate) =>
            normalizeUci(candidate.moveUci) ===
            normalizeUci(args.moveUci)
    );
    if (
        !branch ||
        branch.child.role !== 'OPPONENT' ||
        branch.child.branches.length === 0
    ) {
        return null;
    }
    const opponentBranch =
        branch.child.branches.find(
            (candidate) =>
                normalizeUci(candidate.moveUci) ===
                normalizeUci(
                    branch.child.selectedMoveUci ?? ''
                )
        ) ??
        branch.child.branches.find((candidate) => candidate.best) ??
        branch.child.branches[0]!;
    return opponentBranch.child.role === 'USER'
        ? {
              opponentMoveUci: opponentBranch.moveUci,
              fenAfterOpponentMove: opponentBranch.child.fen,
              nextUserNode: opponentBranch.child,
          }
        : null;
}

export function aggregateTrainingGrade(
    grades: readonly AttemptGrade[]
): AttemptGrade {
    if (grades.some((grade) => grade === 'DIFFERENT_MISTAKE')) {
        return 'DIFFERENT_MISTAKE';
    }
    if (grades.some((grade) => grade === 'REPEATED_MISTAKE')) {
        return 'REPEATED_MISTAKE';
    }
    if (grades.some((grade) => grade === 'IMPROVED')) {
        return 'IMPROVED';
    }
    if (grades.some((grade) => grade === 'GOOD')) return 'GOOD';
    return 'BEST';
}
