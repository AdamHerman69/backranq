import type { MultiPvLine } from '@/lib/analysis/stockfishClient';
import type {
    AcceptanceFrontier,
    AcceptedMoveTier,
    GradingPolicyV3,
} from './contracts';
import {
    engineScoreToWhitePov,
    engineWdlChance,
    metricsFromMatchedOutcomeEvidence,
} from './gradingEvidence';
import { gradeTrainingMove } from './grader';

// Retained exported calibration constants for instrumentation; no hidden expansion.
export const ACCEPTANCE_BOUNDARY_MIN_GAP_CP = 30;
export const ACCEPTANCE_BOUNDARY_MAX_EXPANSION_CP = 0;

/** Individual answer quality. This object never certifies unlisted legal moves. */
export function acceptanceFrontierFromMultiPv(args: {
    lines: readonly MultiPvLine[];
    requestedMultiPv: number;
    alternativesComplete?: boolean;
    policy: GradingPolicyV3;
}): AcceptanceFrontier {
    const ordered = args.lines.slice().sort((a, b) => a.multipv - b.multipv);
    const best = ordered[0];
    const seen = new Set<string>();
    const moves: AcceptanceFrontier['moves'] = [];
    let firstRejectedMoveUci: string | null = null;
    let invalid = !best?.score;
    let previousCp: number | null = null;
    for (const [index, line] of ordered.entries()) {
        const moveUci = line.pvUci[0]?.trim().toLowerCase() ?? '';
        if (
            !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveUci) ||
            seen.has(moveUci) ||
            line.multipv !== index + 1 ||
            !line.score ||
            !best?.score
        ) {
            invalid = true;
            continue;
        }
        seen.add(moveUci);
        if (line.score.type === 'cp') {
            if (previousCp != null && line.score.value > previousCp)
                invalid = true;
            previousCp = line.score.value;
        }
        const metrics = metricsFromMatchedOutcomeEvidence({
            moveUci,
            originalMoveUci: '',
            trainingSide: 'w',
            bestScore: engineScoreToWhitePov(best.score, 'w'),
            submittedScore: engineScoreToWhitePov(line.score, 'w'),
            originalScore: null,
            bestWdlChance: engineWdlChance(best.wdl, 'w', 'w'),
            submittedWdlChance: engineWdlChance(line.wdl, 'w', 'w'),
            stable: true,
        });
        const result = gradeTrainingMove(metrics, args.policy);
        if (result.status === 'GRADED' && result.accepted)
            moves.push({ moveUci, tier: result.grade as AcceptedMoveTier });
        else firstRejectedMoveUci ??= moveUci;
    }
    return {
        version: 1,
        status: invalid ? 'UNSTABLE' : moves.length ? 'STABLE' : 'OPEN',
        targetCutoffCp: args.policy.success.maxCpLoss,
        effectiveCutoffCp: null,
        boundaryGapCp: null,
        moves,
        firstRejectedMoveUci,
    };
}

/** Keep independently supported answers; marginal alternatives never invalidate the core. */
export function confirmAcceptanceFrontier(
    first: AcceptanceFrontier,
    confirmation: AcceptanceFrontier,
): AcceptanceFrontier {
    const rank: Record<AcceptedMoveTier, number> = {
        BEST: 0,
        STRONG: 1,
        GOOD: 2,
    };
    const previous = new Map(
        first.moves.map((move) => [move.moveUci, move.tier]),
    );
    const moves = confirmation.moves
        .filter((move) => previous.has(move.moveUci))
        .map((move) => ({
            ...move,
            tier:
                rank[previous.get(move.moveUci)!] > rank[move.tier]
                    ? previous.get(move.moveUci)!
                    : move.tier,
        }));
    return {
        ...confirmation,
        moves,
        status:
            first.status === 'UNSTABLE' || confirmation.status === 'UNSTABLE'
                ? 'UNSTABLE'
                : moves.length
                  ? 'STABLE'
                  : 'OPEN',
    };
}
