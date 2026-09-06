import type { EngineWdl, Score } from '@/lib/analysis/stockfishClient';
import type { PovScore } from '@/lib/training/contracts';
import type { TrainingMoveMetrics } from '@/lib/training/grader';

const WIN_CHANCE_MULTIPLIER = 0.00368208;

export function scoreForTrainingSide(
    score: PovScore | null,
    trainingSide: 'w' | 'b',
): { cp: number | null; chance: number | null } {
    if (!score) return { cp: null, chance: null };
    if (score.kind === 'cp') {
        const cp = trainingSide === 'w' ? score.cp : -score.cp;
        return {
            cp,
            chance: 1 / (1 + Math.exp(-WIN_CHANCE_MULTIPLIER * cp)),
        };
    }
    if (score.kind === 'mate') {
        const wins =
            (score.winner === 'WHITE' && trainingSide === 'w') ||
            (score.winner === 'BLACK' && trainingSide === 'b');
        return { cp: null, chance: wins ? 1 : 0 };
    }
    const whiteChance =
        score.wdl === 'WIN' ? 1 : score.wdl === 'DRAW' ? 0.5 : 0;
    return {
        cp: null,
        chance: trainingSide === 'w' ? whiteChance : 1 - whiteChance,
    };
}

function exactOutcome(
    score: PovScore | null,
    trainingSide: 'w' | 'b',
): number | null {
    return score && score.kind !== 'cp'
        ? scoreForTrainingSide(score, trainingSide).chance
        : null;
}

function exactBestOutcomeCompatibility(args: {
    bestScore: PovScore | null;
    submittedScore: PovScore | null;
    trainingSide: 'w' | 'b';
}): boolean | null {
    const best = exactOutcome(args.bestScore, args.trainingSide);
    if (best == null) return null;
    const submitted = exactOutcome(args.submittedScore, args.trainingSide);
    return submitted != null && submitted >= best;
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

function finiteProbability(value: unknown): number | null {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1
        ? value
        : null;
}

function roundedProbability(value: number): number {
    return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function metricsFromPovScores(args: {
    moveUci: string;
    originalMoveUci: string;
    trainingSide: 'w' | 'b';
    bestScore: PovScore | null;
    submittedScore: PovScore | null;
    originalScore: PovScore | null;
    evidence?: unknown;
}): TrainingMoveMetrics {
    const best = scoreForTrainingSide(args.bestScore, args.trainingSide);
    const submitted = scoreForTrainingSide(
        args.submittedScore,
        args.trainingSide,
    );
    const original = scoreForTrainingSide(
        args.originalScore,
        args.trainingSide,
    );
    const evidence =
        args.evidence &&
        typeof args.evidence === 'object' &&
        !Array.isArray(args.evidence)
            ? (args.evidence as Record<string, unknown>)
            : {};
    const evidenceCp = finiteNonNegative(evidence.bestGapCp);
    const evidenceChance = finiteNonNegative(evidence.bestGapWinChance);
    const evidenceRecoveredCp = finiteNonNegative(evidence.recoveredCp);
    const evidenceRecoveredChance = finiteNonNegative(
        evidence.recoveredWinChance,
    );
    const bestGapCp =
        evidenceCp ??
        (best.cp != null && submitted.cp != null
            ? Math.max(0, best.cp - submitted.cp)
            : null);
    const exact =
        args.bestScore?.kind !== 'cp' && args.submittedScore?.kind !== 'cp';
    const bestGapWinChance =
        evidenceChance ??
        (exact && best.chance != null && submitted.chance != null
            ? Math.max(0, best.chance - submitted.chance)
            : null);
    return {
        moveUci: args.moveUci,
        originalMoveUci: args.originalMoveUci,
        stable:
            args.submittedScore != null &&
            (bestGapCp != null || bestGapWinChance != null),
        bestGapCp,
        bestGapWinChance,
        recoveredCp:
            evidenceRecoveredCp ??
            (submitted.cp != null && original.cp != null
                ? Math.max(0, submitted.cp - original.cp)
                : null),
        recoveredWinChance:
            evidenceRecoveredChance ??
            (args.submittedScore?.kind !== 'cp' &&
            args.originalScore?.kind !== 'cp' &&
            submitted.chance != null &&
            original.chance != null
                ? Math.max(0, submitted.chance - original.chance)
                : null),
        preservesOutcome:
            typeof evidence.preservesOutcome === 'boolean'
                ? evidence.preservesOutcome
                : exactBestOutcomeCompatibility(args),
        evidenceModel:
            evidence.evidenceModel === 'MATCHED_WDL' ||
            evidence.evidenceModel === 'EXACT_OUTCOME' ||
            evidence.evidenceModel === 'CP_ONLY'
                ? evidence.evidenceModel
                : args.bestScore?.kind === 'cp'
                  ? 'CP_ONLY'
                  : 'EXACT_OUTCOME',
        referenceOutdated: evidence.referenceOutdated === true,
    };
}

/**
 * Builds one grading comparison from evidence collected at the same engine
 * budget for the root best move and the submitted move.
 *
 * Matched WDL is authoritative. If either side lacks WDL, centipawn loss is
 * the fallback and winning-chance loss remains absent. Mate and tablebase
 * best outcomes are compared as explicit outcomes rather than synthetic cp.
 */
export function metricsFromMatchedOutcomeEvidence(args: {
    moveUci: string;
    originalMoveUci: string;
    trainingSide: 'w' | 'b';
    bestScore: PovScore | null;
    submittedScore: PovScore | null;
    originalScore: PovScore | null;
    bestWdlChance?: number | null;
    submittedWdlChance?: number | null;
    originalWdlChance?: number | null;
    stable: boolean;
}): TrainingMoveMetrics {
    const base = metricsFromPovScores({
        moveUci: args.moveUci,
        originalMoveUci: args.originalMoveUci,
        trainingSide: args.trainingSide,
        bestScore: args.bestScore,
        submittedScore: args.submittedScore,
        originalScore: args.originalScore,
    });
    const exactCompatibility = exactBestOutcomeCompatibility(args);
    if (exactCompatibility != null) {
        return {
            ...base,
            stable:
                args.stable &&
                args.bestScore != null &&
                args.submittedScore != null,
            bestGapCp: null,
            bestGapWinChance: exactCompatibility ? 0 : 1,
            recoveredWinChance: null,
            preservesOutcome: exactCompatibility,
            evidenceModel: 'EXACT_OUTCOME',
            referenceOutdated:
                (exactOutcome(args.submittedScore, args.trainingSide) != null &&
                    exactOutcome(args.submittedScore, args.trainingSide)! >
                        exactOutcome(args.bestScore, args.trainingSide)!) ||
                (exactOutcome(args.bestScore, args.trainingSide) === 0 &&
                    args.submittedScore?.kind === 'cp'),
        };
    }

    const bestWdlChance = finiteProbability(args.bestWdlChance);
    const submittedWdlChance = finiteProbability(args.submittedWdlChance);
    const originalWdlChance = finiteProbability(args.originalWdlChance);
    const hasMatchedWdl = bestWdlChance != null && submittedWdlChance != null;
    const bestGapWinChance = hasMatchedWdl
        ? roundedProbability(Math.max(0, bestWdlChance - submittedWdlChance))
        : null;
    // A cp sign or model probability is not a rule-exact outcome.
    const preservesOutcome = null;
    const recoveredWinChance =
        hasMatchedWdl && originalWdlChance != null
            ? roundedProbability(
                  Math.max(0, submittedWdlChance - originalWdlChance),
              )
            : null;

    return {
        ...base,
        stable:
            args.stable &&
            args.bestScore != null &&
            args.submittedScore != null &&
            (hasMatchedWdl || base.bestGapCp != null),
        bestGapWinChance,
        recoveredWinChance,
        preservesOutcome,
        evidenceModel: hasMatchedWdl ? 'MATCHED_WDL' : 'CP_ONLY',
        referenceOutdated:
            (args.bestScore?.kind === 'cp' &&
                args.submittedScore?.kind === 'cp' &&
                (args.trainingSide === 'w' ? 1 : -1) * args.submittedScore.cp >
                    (args.trainingSide === 'w' ? 1 : -1) * args.bestScore.cp) ||
            (args.bestScore?.kind === 'cp' &&
                exactOutcome(args.submittedScore, args.trainingSide) === 1) ||
            (hasMatchedWdl && submittedWdlChance > bestWdlChance),
    };
}

export function engineScoreToWhitePov(
    score: Score | null,
    scorePov: 'w' | 'b',
): PovScore | null {
    if (!score) return null;
    if (score.type === 'cp') {
        return {
            kind: 'cp',
            cp: scorePov === 'w' ? score.value : -score.value,
            pov: 'WHITE',
        };
    }
    const winner = score.value > 0 ? scorePov : scorePov === 'w' ? 'b' : 'w';
    const distance = Math.abs(Math.trunc(score.value));
    return {
        kind: 'mate',
        plies: score.value > 0 ? distance * 2 - 1 : distance * 2,
        winner: winner === 'w' ? 'WHITE' : 'BLACK',
    };
}

export function engineWdlChance(
    wdl: EngineWdl | undefined,
    scorePov: 'w' | 'b',
    trainingSide: 'w' | 'b',
): number | null {
    if (!wdl) return null;
    const total = wdl.win + wdl.draw + wdl.loss;
    if (total <= 0) return null;
    const scorePovChance = (wdl.win + wdl.draw * 0.5) / total;
    return scorePov === trainingSide ? scorePovChance : 1 - scorePovChance;
}

export function trainingWdlToWhitePov(
    wdl: 'WIN' | 'DRAW' | 'LOSS',
    trainingSide: 'w' | 'b',
    dtz?: number,
): PovScore {
    const whiteWdl =
        trainingSide === 'w'
            ? wdl
            : wdl === 'WIN'
              ? 'LOSS'
              : wdl === 'LOSS'
                ? 'WIN'
                : 'DRAW';
    return {
        kind: 'tablebase',
        wdl: whiteWdl,
        pov: 'WHITE',
        ...(dtz == null ? {} : { dtz }),
    };
}
