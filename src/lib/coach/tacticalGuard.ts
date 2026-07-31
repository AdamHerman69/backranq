import { evaluationLoss } from '@/lib/analysis/evaluation';
import type {
    MultiPvLine,
    MultiPvResult,
} from '@/lib/analysis/stockfishClient';
import { sampleWeightedMaiaCandidate } from '@/lib/coach/maia/sampling';
import type { MaiaMoveCandidate } from '@/lib/coach/maia/types';
import { normalizeMaiaTacticalGuardCp } from '@/lib/coach/profiles';

const EXACT_UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export type TacticalGuardSelection = {
    moveUci: string;
    source: 'maia' | 'stockfish-fallback';
    lossCp: number;
    safeCandidateCount: number;
    evaluatedCandidateCount: number;
};

function rootMove(line: MultiPvLine): string | null {
    const move = line.pvUci[0]?.trim().toLowerCase() ?? '';
    return EXACT_UCI_RE.test(move) ? move : null;
}

/**
 * Keeps Maia's relative policy weights, but only among moves proven to remain
 * below the configured centipawn loss. Missing or malformed engine evidence is
 * never treated as safe.
 */
export function selectTacticalGuardMove(args: {
    maiaCandidates: readonly MaiaMoveCandidate[];
    analysis: MultiPvResult;
    thresholdCp: number;
    seed: number;
}): TacticalGuardSelection {
    const lines = args.analysis.lines
        .slice()
        .sort((left, right) => left.multipv - right.multipv);
    const best = lines[0];
    const bestMove = best ? rootMove(best) : null;
    if (!best || !bestMove || best.score == null) {
        throw new Error(
            'Tactical guard could not verify a legal Stockfish fallback.'
        );
    }

    const lineByMove = new Map<string, MultiPvLine>();
    for (const line of lines) {
        const move = rootMove(line);
        if (move && line.score != null && !lineByMove.has(move)) {
            lineByMove.set(move, line);
        }
    }

    const thresholdCp = normalizeMaiaTacticalGuardCp(args.thresholdCp);
    const seen = new Set<string>();
    const evaluated = args.maiaCandidates.flatMap((candidate) => {
        const moveUci = candidate.moveUci.trim().toLowerCase();
        if (
            !EXACT_UCI_RE.test(moveUci) ||
            seen.has(moveUci) ||
            !Number.isFinite(candidate.probability) ||
            candidate.probability < 0
        ) {
            return [];
        }
        seen.add(moveUci);
        const line = lineByMove.get(moveUci);
        if (!line) return [];
        const loss = evaluationLoss(
            { score: best.score, wdl: best.wdl },
            { score: line.score, wdl: line.wdl }
        );
        if (loss.cp == null || !Number.isFinite(loss.cp)) return [];
        return [{ ...candidate, moveUci, lossCp: loss.cp }];
    });
    const safe = evaluated.filter(
        (candidate) => candidate.lossCp < thresholdCp
    );

    if (safe.length === 0) {
        return {
            moveUci: bestMove,
            source: 'stockfish-fallback',
            lossCp: 0,
            safeCandidateCount: 0,
            evaluatedCandidateCount: evaluated.length,
        };
    }

    const selected = sampleWeightedMaiaCandidate(safe, args.seed).candidate;
    return {
        moveUci: selected.moveUci,
        source: 'maia',
        lossCp: selected.lossCp,
        safeCandidateCount: safe.length,
        evaluatedCandidateCount: evaluated.length,
    };
}
