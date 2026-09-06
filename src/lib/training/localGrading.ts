import { Chess } from 'chess.js';
import { appendAssessmentHistory } from '@/lib/training/assessmentIdentity';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';

import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import type {
    TrainingComparisonDto,
    TrainingClientMoveEvidence,
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

const LOCAL_PASS_NODES = [100_000, 200_000, 400_000] as const;
const LOCAL_ENGINE_TIMEOUT_MS = 20_000;

export type LocalMoveEvaluation = {
    result: TrainingMoveGradeResult;
    source: 'PRECOMPUTED' | 'CLIENT_EVALUATED' | 'TABLEBASE';
    clientEvidence?: TrainingClientMoveEvidence;
    refinementNeeded?: boolean;
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
                assessment.positionKey === args.node.contextId &&
                assessment.referenceId === (args.node.answerCoverage ?? args.manifest.answerCoverage).referenceId &&
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
    const metrics = metricsFromPovScores({
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
    const evidence = args.assessment?.evidence as Partial<TrainingMoveMetrics> | null;
    const exact = metricsFromMatchedOutcomeEvidence({ moveUci: args.moveUci, originalMoveUci: rootDecision ? args.manifest.originalMoveUci : '', trainingSide: args.manifest.trainingSide, bestScore, submittedScore: args.assessment?.scoreAfter ?? null, originalScore: rootDecision ? args.manifest.originalScoreAfter : null, stable: true });
    if (exact.evidenceModel === 'EXACT_OUTCOME') return { ...exact, stable: exact.stable && evidence?.stable !== false, referenceOutdated: exact.referenceOutdated || evidence?.referenceOutdated === true };
    return { ...metrics, stable: metrics.stable && evidence?.stable !== false, evidenceModel: metrics.bestGapWinChance == null ? 'CP_ONLY' : 'MATCHED_WDL', referenceOutdated: evidence?.referenceOutdated === true || (args.assessment?.scoreAfter != null && exact.referenceOutdated === true) };

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
    const assessment = assessmentForMove({ ...args, moveUci: move });
    if (assessment && assessment.source !== 'DYNAMIC') {
        const metrics = knownMetrics({ ...args, moveUci: move, assessment });
        const derived = gradeTrainingMove(metrics, args.manifest.gradingPolicy);
        const rawEvidence = assessment.evidence as { membership?: { status?: string; contextId?: string; referenceId?: string; policyVersion?: number; stable?: boolean } } | null;
        const membership = rawEvidence?.membership;
        const supportedMembership = !metrics.referenceOutdated && membership?.status === 'ACCEPTED' && membership.stable === true && membership.contextId === args.node.contextId && membership.referenceId === assessment.referenceId && membership.policyVersion === args.manifest.gradingPolicy.version && args.node.acceptedMovesUci.includes(move);
        if (derived.status !== 'GRADED' && !supportedMembership) return null;
        const result: TrainingMoveGradeResult = derived.status === 'GRADED'
            ? derived.accepted && !assessment.tierStable ? { status: 'GRADED', grade: 'GOOD', accepted: true } : derived
            : { status: 'GRADED', grade: 'GOOD', accepted: true };
        return {
            result,
            source: assessment.source,
            scoreAfter: assessment.scoreAfter,
            comparison: metrics.stable ? comparisonFromMetrics(assessment.scoreAfter, metrics) : null,
            evidence: { kind: derived.status === 'GRADED' ? 'POLICY_CHECKED_ASSESSMENT' : 'SUPPORTED_ACCEPTED_MEMBERSHIP', assessment: assessment.evidence },
            refinementNeeded: !assessment.tierStable || derived.status !== 'GRADED',
        };
    }

    const coverage = args.node.answerCoverage ?? (isRoot ? args.manifest.answerCoverage : null);
    if (coverage && coverage.contextId === args.node.contextId &&
        coverage.status !== 'PARTIAL' && coverage.coveredMovesUci.includes(move)) {
        return {
            result: { status: 'GRADED', grade: 'DIFFERENT_MISTAKE', accepted: false },
            source: 'PRECOMPUTED', scoreAfter: null, comparison: null,
            evidence: { kind: 'CERTIFIED_BELOW_QUALITY_BOUNDARY', coverage },
            refinementNeeded: true,
        };
    }
    return null;
}

function terminalOutcome(fen: string, previousFens: readonly string[]): { reason: string; score: PovScore } | null {
    const result = ruleTerminalEvaluation(fen, previousFens);
    if (!result?.terminal) return null;
    return {
        reason: result.terminal.kind,
        score: result.terminal.outcome === 'DRAW'
            ? { kind: 'tablebase', wdl: 'DRAW', pov: 'WHITE' }
            : { kind: 'mate', plies: 0, winner: new Chess(fen).turn() === 'w' ? 'BLACK' : 'WHITE' },
    };
}

function stableEngineEvidence(args: {
    firstScore: PovScore | null;
    firstWdlChance: number | null;
    secondScore: PovScore | null;
    secondWdlChance: number | null;
    trainingSide: 'w' | 'b';
}): boolean {
    if (!args.firstScore || !args.secondScore) return false;
    if (args.firstScore.kind === 'mate' && args.secondScore.kind === 'mate' && args.firstScore.winner !== args.secondScore.winner) return false;
    if (args.firstWdlChance != null && args.secondWdlChance != null && Number.isFinite(args.firstWdlChance) && Number.isFinite(args.secondWdlChance)) {
        return Math.abs(args.firstWdlChance - args.secondWdlChance) <= 0.05;
    }
    if (args.firstScore.kind === 'mate' || args.secondScore.kind === 'mate') {
        return args.firstScore.kind === 'mate' && args.secondScore.kind === 'mate' && args.firstScore.winner === args.secondScore.winner;
    }
    if (args.firstScore.kind === 'tablebase' || args.secondScore.kind === 'tablebase') {
        return args.firstScore.kind === 'tablebase' && args.secondScore.kind === 'tablebase' && args.firstScore.wdl === args.secondScore.wdl;
    }
    return Math.abs(args.firstScore.cp - args.secondScore.cp) <= 75;
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
    const wdl = [args.firstBestWdlChance, args.firstSubmittedWdlChance, args.secondBestWdlChance, args.secondSubmittedWdlChance];
    if (wdl.every((value): value is number => typeof value === 'number' && Number.isFinite(value)) &&
        Math.abs((wdl[0] - wdl[1]) - (wdl[2] - wdl[3])) > 0.05) return false;
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

/** Bounded fresh matched searches; an unknown move never inherits a PV verdict. */
export async function gradeUnknownLocalMove(args: {
    engine: StockfishEngine;
    manifest: TrainingGradingManifestDto;
    node: TrainingSolutionTreeNodeDto;
    moveUci: string;
    positionHistory?: readonly string[];
    retryEngine?: () => StockfishEngine;
}): Promise<LocalMoveEvaluation> {
    const move = normalizeUci(args.moveUci);
    const fenAfter = applyUci(args.node.fen, move);
    if (!fenAfter) throw new Error('Illegal move');
    const previousFens = args.node.positionHistory;
    const terminal = terminalOutcome(fenAfter, appendAssessmentHistory(previousFens, args.node.fen));
    const pov = new Chess(args.node.fen).turn();
    const rootDecision = args.node.ply === 0;
    const originalMove = rootDecision ? args.manifest.originalMoveUci : '';
    const canonicalBestMove = bestAssessment(args)?.moveUci ?? args.node.selectedMoveUci ?? args.node.acceptedMovesUci[0];
    if (!canonicalBestMove) throw new Error('Missing canonical reference move');
    const deadline = performance.now() + LOCAL_ENGINE_TIMEOUT_MS;
    let engine = args.engine;
    let retriedFailure = false;
    type Pass = { bestScore: PovScore | null; submittedScore: PovScore | null; bestWdlChance: number | null; submittedWdlChance: number | null; metrics: TrainingMoveMetrics };
    let previous: Pass | null = null;
    let evaluation: LocalMoveEvaluation | null = null;
    const searches: TrainingClientMoveEvidence['searches'] = [];
    for (const nodes of LOCAL_PASS_NODES) {
        const search = async (rootMoves?: string[]): Promise<Awaited<ReturnType<StockfishEngine['evalPosition']>>> => {
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error('Local grading budget exhausted');
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    engine.evalPosition({ fen: args.node.fen, previousFens, rootMoves, nodes, timeoutMs: remaining, reuse: 'FRESH_REQUIRED', purpose: 'PRACTICE_MATCHED_COMPARISON' }),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                            engine.cancelAll?.();
                            reject(new Error('Local grading budget exhausted'));
                        }, remaining);
                    }),
                ]);
            } catch (error) {
                if (!retriedFailure && args.retryEngine && performance.now() < deadline) {
                    retriedFailure = true;
                    if (timer) clearTimeout(timer);
                    engine = args.retryEngine();
                    return search(rootMoves);
                }
                throw error;
            } finally {
                if (timer) clearTimeout(timer);
            }
        };
        const best = await search();
        const submitted = terminal ? null : await search([move]);
        const original = originalMove && originalMove !== move ? await search([originalMove]) : submitted;
        const canonical = best.bestMoveUci === canonicalBestMove ? best
            : canonicalBestMove === move ? submitted
            : canonicalBestMove === originalMove ? original
            : await search([canonicalBestMove]);
        const bestScore = engineScoreToWhitePov(best.score, pov);
        const canonicalScore = canonicalBestMove === move && terminal ? terminal.score : engineScoreToWhitePov(canonical?.score ?? null, pov);
        const submittedScore = terminal?.score ?? engineScoreToWhitePov(submitted?.score ?? null, pov);
        const originalScore = originalMove === move ? submittedScore : engineScoreToWhitePov(original?.score ?? null, pov);
        const bestWdlChance = engineWdlChance(best.wdl, pov, args.manifest.trainingSide);
        const submittedWdlChance = terminal ? scoreForTrainingSide(terminal.score, args.manifest.trainingSide).chance : engineWdlChance(submitted?.wdl, pov, args.manifest.trainingSide);
        const metrics = metricsFromMatchedOutcomeEvidence({ moveUci: move, originalMoveUci: originalMove, trainingSide: args.manifest.trainingSide, bestScore, submittedScore, originalScore, bestWdlChance, submittedWdlChance, originalWdlChance: engineWdlChance(original?.wdl, pov, args.manifest.trainingSide), stable: true });
        const canonicalMetrics = metricsFromMatchedOutcomeEvidence({ moveUci: canonicalBestMove, originalMoveUci: '', trainingSide: args.manifest.trainingSide, bestScore, submittedScore: canonicalScore, originalScore: null, bestWdlChance, submittedWdlChance: engineWdlChance(canonical?.wdl, pov, args.manifest.trainingSide), stable: true });
        if (canonicalMetrics.referenceOutdated) metrics.referenceOutdated = true;
        const current = { bestScore, submittedScore, bestWdlChance, submittedWdlChance, metrics: { ...metrics } };
        const compact = (result: typeof best | null) => {
            if (!result) return null;
            const report = result.searchEvidence;
            return { score: result.score, wdl: result.wdl ?? null, searchEvidence: report ? { id: report.id, engine: report.engine, reused: report.reused, reported: report.reported, request: { rootMoves: report.request.rootMoves, historyMode: report.request.historyMode, limits: report.request.limits, purpose: report.request.purpose } } : null };
        };
        searches.push({ nodes, best: compact(best), submitted: compact(submitted), original: compact(original), canonical: compact(canonical) });
        const result = gradeTrainingMove(metrics, args.manifest.gradingPolicy);
        const priorResult = previous ? gradeTrainingMove(previous.metrics, args.manifest.gradingPolicy) : null;
        const stable = !!previous && stableMatchedGap({ firstBestScore: previous.bestScore, firstBestWdlChance: previous.bestWdlChance, firstSubmittedScore: previous.submittedScore, firstSubmittedWdlChance: previous.submittedWdlChance, secondBestScore: bestScore, secondBestWdlChance: bestWdlChance, secondSubmittedScore: submittedScore, secondSubmittedWdlChance: submittedWdlChance, trainingSide: args.manifest.trainingSide }) && result.status === 'GRADED' && priorResult?.status === 'GRADED' && result.accepted === priorResult.accepted;
        const tierStable = result.status === 'GRADED' && priorResult?.status === 'GRADED' && result.grade === priorResult.grade;
        metrics.stable = stable;
        const canonicalReferenceOutdated = (canonicalMetrics.bestGapCp ?? 0) > 0 || (canonicalMetrics.bestGapWinChance ?? 0) > 0;
        if (!bestScore || !canonicalScore) return { result: { status: 'UNRESOLVED', reason: 'MISSING_OUTCOME_EVIDENCE' }, source: 'CLIENT_EVALUATED', scoreAfter: submittedScore, comparison: null, evidence: { searches } };
        const localReference: TrainingClientMoveEvidence['localReference'] = { id: best.searchEvidence?.id ?? crypto.randomUUID(), bestMoveUci: best.bestMoveUci, bestScore, canonicalBestMoveUci: canonicalBestMove, canonicalScore, canonicalReferenceOutdated };
        const clientEvidence: TrainingClientMoveEvidence = { version: 1, contextId: args.node.contextId, referenceId: (args.node.answerCoverage ?? args.manifest.answerCoverage).referenceId, policyVersion: args.manifest.gradingPolicy.version, localReference, tierStable, metrics, scoreAfter: submittedScore, searches: [...searches] };
        evaluation = { result: gradeTrainingMove(metrics, args.manifest.gradingPolicy), source: 'CLIENT_EVALUATED', scoreAfter: submittedScore, comparison: comparisonFromMetrics(submittedScore, metrics), evidence: { kind: terminal ? 'LOCAL_RULE' : 'LOCAL_STOCKFISH', terminal: terminal?.reason ?? null, clientEvidence }, clientEvidence };
        if (stable) return evaluation;
        previous = current;
    }
    return evaluation!;
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
    if (grades.some((grade) => grade === 'STRONG')) return 'STRONG';
    return 'BEST';
}
