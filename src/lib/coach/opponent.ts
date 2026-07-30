import { Chess } from 'chess.js';

import {
    evaluationLoss,
    isWithinEvaluationLoss,
} from '@/lib/analysis/evaluation';
import type {
    MultiPvLine,
    MultiPvResult,
} from '@/lib/analysis/stockfishClient';
import { parseUci } from '@/lib/chess/utils';
import {
    getOpponentProfile,
    type OpponentProfileId,
} from '@/lib/coach/profiles';

export type OpponentMoveSelection = {
    moveUci: string;
    line: MultiPvLine;
    candidateIndex: number;
};

function legalRootMove(fen: string, line: MultiPvLine): string | null {
    const moveUci = line.pvUci[0]?.trim().toLowerCase() ?? '';
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveUci)) return null;
    const parsed = parseUci(moveUci);
    if (!parsed) return null;
    try {
        const chess = new Chess(fen);
        const move = chess.move({
            from: parsed.from,
            to: parsed.to,
            promotion: parsed.promotion,
        });
        return move ? moveUci : null;
    } catch {
        return null;
    }
}

/**
 * Stockfish still calculates every candidate at full strength. Difficulty only
 * changes which bounded, legal alternative the opponent chooses.
 */
export function selectOpponentMove(args: {
    fen: string;
    analysis: MultiPvResult;
    profileId: OpponentProfileId;
    random?: () => number;
}): OpponentMoveSelection {
    const profile = getOpponentProfile(args.profileId);
    const seen = new Set<string>();
    const legal = args.analysis.lines
        .slice()
        .sort((left, right) => left.multipv - right.multipv)
        .flatMap((line) => {
            const moveUci = legalRootMove(args.fen, line);
            if (!moveUci || seen.has(moveUci)) return [];
            seen.add(moveUci);
            return [{ moveUci, line }];
        });
    const best = legal[0];
    if (!best) {
        throw new Error('Stockfish returned no legal opponent move.');
    }

    const candidates = legal.filter((candidate, index) => {
        if (index === 0) return true;
        const loss = evaluationLoss(
            {
                score: best.line.score,
                wdl: best.line.wdl,
            },
            {
                score: candidate.line.score,
                wdl: candidate.line.wdl,
            }
        );
        return isWithinEvaluationLoss(loss, {
            maxWinningChanceLoss: profile.maxWinningChanceLoss,
            fallbackMaxCpLoss: profile.fallbackMaxCpLoss,
        });
    });

    if (profile.id === 'maximum' || candidates.length === 1) {
        return {
            ...best,
            candidateIndex: 0,
        };
    }

    const weights = candidates.map((_, index) =>
        Math.pow(index + 1, profile.selectionBias)
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const rawRandom = args.random?.() ?? Math.random();
    const random = Number.isFinite(rawRandom)
        ? Math.max(0, Math.min(0.999_999_999, rawRandom))
        : 0;
    let cursor = random * totalWeight;
    for (let index = 0; index < candidates.length; index += 1) {
        cursor -= weights[index]!;
        if (cursor < 0) {
            return {
                ...candidates[index]!,
                candidateIndex: index,
            };
        }
    }

    return {
        ...candidates[candidates.length - 1]!,
        candidateIndex: candidates.length - 1,
    };
}
