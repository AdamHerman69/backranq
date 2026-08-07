import { evaluationLoss } from '@/lib/analysis/evaluation';
import type { MultiPvLine } from '@/lib/analysis/stockfishClient';
import type {
    AcceptanceFrontier,
    AcceptedMoveTier,
    GradingPolicyV3,
} from '@/lib/training/contracts';

export const ACCEPTANCE_BOUNDARY_MIN_GAP_CP = 30;
export const ACCEPTANCE_BOUNDARY_MAX_EXPANSION_CP = 40;

type RankedMove = {
    moveUci: string;
    line: MultiPvLine;
    lossCp: number;
};

function normalizeUci(value: string | undefined): string {
    return value?.trim().toLowerCase() ?? '';
}

function tierForLoss(
    lossCp: number,
    policy: GradingPolicyV3
): AcceptedMoveTier {
    if (lossCp <= policy.best.maxCpLoss) return 'BEST';
    if (lossCp <= policy.strong.maxCpLoss) return 'STRONG';
    return 'GOOD';
}

function openFrontier(args: {
    policy: GradingPolicyV3;
    ranked: RankedMove[];
    status?: 'OPEN' | 'UNSTABLE';
}): AcceptanceFrontier {
    const accepted = args.ranked.filter(
        (move) => move.lossCp <= args.policy.success.maxCpLoss
    );
    return {
        version: 1,
        status: args.status ?? 'OPEN',
        targetCutoffCp: args.policy.success.maxCpLoss,
        effectiveCutoffCp: null,
        boundaryGapCp: null,
        moves: accepted.map((move) => ({
            moveUci: move.moveUci,
            tier: tierForLoss(move.lossCp, args.policy),
        })),
        firstRejectedMoveUci:
            args.ranked[accepted.length]?.moveUci ?? null,
    };
}

/**
 * Turns one exact, ranked MultiPV snapshot into a monotone accepted prefix.
 * All moves at or below the target cutoff are kept. If the cutoff lands inside
 * a near-equal cluster, the prefix expands until a natural evaluation gap.
 */
export function acceptanceFrontierFromMultiPv(args: {
    lines: readonly MultiPvLine[];
    requestedMultiPv: number;
    alternativesComplete?: boolean;
    policy: GradingPolicyV3;
}): AcceptanceFrontier {
    const ordered = args.lines
        .slice()
        .sort((left, right) => left.multipv - right.multipv);
    const best = ordered[0];
    if (!best?.score) {
        return openFrontier({
            policy: args.policy,
            ranked: [],
            status: 'UNSTABLE',
        });
    }

    const seen = new Set<string>();
    const ranked: RankedMove[] = [];
    let duplicateRootMove = false;
    for (let index = 0; index < ordered.length; index += 1) {
        const line = ordered[index]!;
        const moveUci = normalizeUci(line.pvUci[0]);
        const loss = evaluationLoss(
            { score: best.score, wdl: best.wdl },
            { score: line.score, wdl: line.wdl }
        );
        if (moveUci && seen.has(moveUci)) {
            duplicateRootMove = true;
            continue;
        }
        if (
            line.multipv !== index + 1 ||
            !moveUci ||
            line.score == null ||
            loss.cp == null ||
            !Number.isFinite(loss.cp)
        ) {
            return openFrontier({
                policy: args.policy,
                ranked,
                status: 'UNSTABLE',
            });
        }
        const lossCp = Math.max(0, loss.cp);
        if (
            ranked.length > 0 &&
            lossCp < ranked[ranked.length - 1]!.lossCp
        ) {
            return openFrontier({
                policy: args.policy,
                ranked,
                status: 'UNSTABLE',
            });
        }
        seen.add(moveUci);
        ranked.push({ moveUci, line, lossCp });
    }
    if (ranked.length === 0) {
        return openFrontier({
            policy: args.policy,
            ranked,
            status: 'UNSTABLE',
        });
    }
    if (duplicateRootMove) {
        return openFrontier({
            policy: args.policy,
            ranked,
            status: 'UNSTABLE',
        });
    }

    const target = args.policy.success.maxCpLoss;
    const maxExpansion = target + ACCEPTANCE_BOUNDARY_MAX_EXPANSION_CP;
    let acceptedEnd = ranked.findLastIndex(
        (move) => move.lossCp <= target
    );
    acceptedEnd = Math.max(0, acceptedEnd);

    while (acceptedEnd + 1 < ranked.length) {
        const acceptedEdge = ranked[acceptedEnd]!;
        const rejectedEdge = ranked[acceptedEnd + 1]!;
        const gap = rejectedEdge.lossCp - acceptedEdge.lossCp;
        if (gap >= ACCEPTANCE_BOUNDARY_MIN_GAP_CP) {
            const accepted = ranked.slice(0, acceptedEnd + 1);
            return {
                version: 1,
                status: 'STABLE',
                targetCutoffCp: target,
                effectiveCutoffCp: Math.round(
                    (acceptedEdge.lossCp + rejectedEdge.lossCp) / 2
                ),
                boundaryGapCp: gap,
                moves: accepted.map((move) => ({
                    moveUci: move.moveUci,
                    tier: tierForLoss(move.lossCp, args.policy),
                })),
                firstRejectedMoveUci: rejectedEdge.moveUci,
            };
        }
        if (rejectedEdge.lossCp > maxExpansion) {
            return openFrontier({ policy: args.policy, ranked });
        }
        acceptedEnd += 1;
    }

    const structurallyExhausted =
        args.alternativesComplete === true &&
        ranked.length < Math.max(1, Math.trunc(args.requestedMultiPv));
    if (!structurallyExhausted) {
        return openFrontier({ policy: args.policy, ranked });
    }
    const accepted = ranked.slice(0, acceptedEnd + 1);
    return {
        version: 1,
        status: 'STABLE',
        targetCutoffCp: target,
        effectiveCutoffCp: accepted.at(-1)?.lossCp ?? 0,
        boundaryGapCp: null,
        moves: accepted.map((move) => ({
            moveUci: move.moveUci,
            tier: tierForLoss(move.lossCp, args.policy),
        })),
        firstRejectedMoveUci: null,
    };
}

export function confirmAcceptanceFrontier(
    first: AcceptanceFrontier,
    confirmation: AcceptanceFrontier
): AcceptanceFrontier {
    const sameMoves =
        first.moves.length === confirmation.moves.length &&
        first.moves.every(
            (move, index) =>
                move.moveUci === confirmation.moves[index]?.moveUci &&
                move.tier === confirmation.moves[index]?.tier
        );
    if (
        first.status !== 'STABLE' ||
        confirmation.status !== 'STABLE' ||
        !sameMoves
    ) {
        return {
            ...confirmation,
            status:
                first.status === 'UNSTABLE' ||
                confirmation.status === 'UNSTABLE'
                    ? 'UNSTABLE'
                    : 'OPEN',
            effectiveCutoffCp: null,
            boundaryGapCp: null,
        };
    }
    return confirmation;
}
