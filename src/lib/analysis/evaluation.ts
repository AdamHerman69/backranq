import type { EngineWdl, Score } from '@/lib/analysis/stockfishClient';

/**
 * This value is only for ordering scores and legacy cp thresholds. Mate remains
 * explicit in persisted/runtime evidence and is never subjected to cp eval bands.
 */
export const MATE_ORDERING_CP = 100_000;

const WIN_CHANCE_MULTIPLIER = 0.00368208;

export function negateScore(score: Score | null): Score | null {
    return score ? { ...score, value: -score.value } : null;
}

export function reverseWdl(wdl?: EngineWdl): EngineWdl | undefined {
    return wdl
        ? {
              win: wdl.loss,
              draw: wdl.draw,
              loss: wdl.win,
          }
        : undefined;
}

/**
 * Stockfish reports score/WDL for the side to move. User-facing numeric
 * evaluation throughout Backranq is always White POV: positive means White is
 * better and negative means Black is better, regardless of board orientation.
 */
export function engineScoreForWhite(
    score: Score | null,
    fen: string
): Score | null {
    return fen.split(' ')[1] === 'b' ? negateScore(score) : score;
}

export function engineWdlForWhite(
    wdl: EngineWdl | undefined,
    fen: string
): EngineWdl | undefined {
    return fen.split(' ')[1] === 'b' ? reverseWdl(wdl) : wdl;
}

export function formatEngineScoreForWhite(
    score: Score | null,
    fen: string
): string {
    const whiteScore = engineScoreForWhite(score, fen);
    if (!whiteScore) return '—';
    if (whiteScore.type === 'mate') {
        if (whiteScore.value === 0) return '#0';
        const sign = whiteScore.value > 0 ? '' : '−';
        return `#${sign}${Math.abs(whiteScore.value)}`;
    }
    const pawns = whiteScore.value / 100;
    if (Math.abs(pawns) < 0.005) return '0.00';
    return `${pawns > 0 ? '+' : '−'}${Math.abs(pawns).toFixed(2)}`;
}

export function whiteExpectedScore(args: {
    score: Score | null;
    wdl?: EngineWdl;
    fen: string;
}): number {
    const value = winningChance(
        engineScoreForWhite(args.score, args.fen),
        engineWdlForWhite(args.wdl, args.fen)
    );
    return value == null || !Number.isFinite(value)
        ? 0.5
        : Math.max(0, Math.min(1, value));
}

export function formatEngineWdlForWhite(
    wdl: EngineWdl | undefined,
    fen: string
): string | null {
    const whiteWdl = engineWdlForWhite(wdl, fen);
    if (!whiteWdl) return null;
    const total = whiteWdl.win + whiteWdl.draw + whiteWdl.loss;
    if (total <= 0) return null;
    const percent = (value: number) =>
        Math.round((Math.max(0, value) / total) * 100);
    return `W ${percent(whiteWdl.win)}% · D ${percent(whiteWdl.draw)}% · L ${percent(whiteWdl.loss)}%`;
}

export function scoreToOrderingCp(score: Score | null): number | null {
    if (!score) return null;
    if (score.type === 'cp') return score.value;
    if (score.value === 0) return 0;

    // Prefer a shorter win and a longer unavoidable loss while retaining a
    // stable, finite ordering compatible with existing cp thresholds.
    const distancePenalty = Math.min(
        Math.abs(Math.trunc(score.value)),
        MATE_ORDERING_CP / 10
    );
    return score.value > 0
        ? MATE_ORDERING_CP - distancePenalty
        : -MATE_ORDERING_CP + distancePenalty;
}

/**
 * Expected score in [0, 1] from the score owner's perspective.
 * UCI WDL is preferred when available; otherwise use a smooth cp model.
 */
export function winningChance(
    score: Score | null,
    wdl?: EngineWdl
): number | null {
    if (wdl) {
        const total = wdl.win + wdl.draw + wdl.loss;
        if (total > 0) return (wdl.win + wdl.draw * 0.5) / total;
    }
    if (!score) return null;
    if (score.type === 'mate') {
        if (score.value > 0) return 1;
        if (score.value < 0) return 0;
        return 0.5;
    }
    return 1 / (1 + Math.exp(-WIN_CHANCE_MULTIPLIER * score.value));
}

export type EvaluationEvidence = {
    score: Score | null;
    wdl?: EngineWdl;
};

export type EvaluationLoss = {
    cp: number | null;
    winningChance: number | null;
};

export type EvaluationLossThreshold = {
    /** Primary, saturation-aware eligibility threshold. */
    minWinningChanceLoss: number;
    /** Used only when winning-chance evidence cannot be computed. */
    fallbackMinCpLoss: number;
};

/**
 * Loss between the best result and a played result, both expressed from the
 * same player's perspective. Positive values mean the played result is worse.
 */
export function evaluationLoss(
    best: EvaluationEvidence,
    played: EvaluationEvidence
): EvaluationLoss {
    const bestCp = scoreToOrderingCp(best.score);
    const playedCp = scoreToOrderingCp(played.score);
    const bestChance = winningChance(best.score, best.wdl);
    const playedChance = winningChance(played.score, played.wdl);

    return {
        cp:
            bestCp == null || playedCp == null
                ? null
                : Math.max(0, bestCp - playedCp),
        winningChance:
            bestChance == null || playedChance == null
                ? null
                : Math.max(0, bestChance - playedChance),
    };
}

/**
 * Winning-chance loss is authoritative whenever it is available. This avoids
 * treating a 200cp fluctuation in an already completely won/lost position as
 * equivalent to the same fluctuation around equality.
 */
export function qualifiesEvaluationLoss(
    loss: EvaluationLoss,
    threshold: EvaluationLossThreshold
): boolean {
    if (
        loss.winningChance != null &&
        Number.isFinite(loss.winningChance)
    ) {
        return (
            loss.winningChance >=
            Math.max(0, threshold.minWinningChanceLoss)
        );
    }
    return (
        loss.cp != null &&
        Number.isFinite(loss.cp) &&
        loss.cp >= Math.max(0, threshold.fallbackMinCpLoss)
    );
}

export function isWithinEvaluationLoss(
    loss: EvaluationLoss,
    threshold: {
        maxWinningChanceLoss: number;
        fallbackMaxCpLoss: number;
    }
): boolean {
    if (
        loss.winningChance != null &&
        Number.isFinite(loss.winningChance)
    ) {
        return (
            loss.winningChance <=
            Math.max(0, threshold.maxWinningChanceLoss)
        );
    }
    return (
        loss.cp != null &&
        Number.isFinite(loss.cp) &&
        loss.cp <= Math.max(0, threshold.fallbackMaxCpLoss)
    );
}

export function isMateScore(score: Score | null): boolean {
    return score?.type === 'mate';
}

export function isWinningMate(score: Score | null): boolean {
    return score?.type === 'mate' && score.value > 0;
}
