import type { MaiaLegalMove } from '@/lib/coach/maia/preprocess';

export type MaiaPolicySample = MaiaLegalMove & {
    probability: number;
    candidateCount: number;
    seed: number;
};

export function normalizeMaiaSeed(seed: number): number {
    if (!Number.isFinite(seed)) {
        throw new Error('Maia seed must be a finite number.');
    }
    return Math.trunc(seed) >>> 0;
}
/** Mulberry32: compact, stable and fully specified for replayable games. */
function seededRandom(seed: number): number {
    let value = (seed + 0x6d2b79f5) >>> 0;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

export function sampleMaiaPolicy(args: {
    logits: ArrayLike<number>;
    legalMoves: readonly MaiaLegalMove[];
    seed: number;
    temperature: number;
    topP: number;
}): MaiaPolicySample {
    if (args.legalMoves.length === 0) {
        throw new Error('Cannot sample Maia policy without legal moves.');
    }
    if (!(args.temperature > 0) || !Number.isFinite(args.temperature)) {
        throw new Error('Maia temperature must be positive and finite.');
    }
    if (
        !(args.topP > 0) ||
        args.topP > 1 ||
        !Number.isFinite(args.topP)
    ) {
        throw new Error('Maia top-p must be within (0, 1].');
    }

    const candidates = args.legalMoves.map((move) => {
        const logit = Number(args.logits[move.modelIndex]);
        if (!Number.isFinite(logit)) {
            throw new Error(
                `Maia returned an invalid logit for move ${move.moveUci}.`
            );
        }
        return {
            ...move,
            scaledLogit: logit / args.temperature,
            probability: 0,
        };
    });
    const maxLogit = Math.max(
        ...candidates.map((candidate) => candidate.scaledLogit)
    );
    let total = 0;
    for (const candidate of candidates) {
        candidate.probability = Math.exp(candidate.scaledLogit - maxLogit);
        total += candidate.probability;
    }
    if (!(total > 0) || !Number.isFinite(total)) {
        throw new Error('Maia returned an invalid legal policy.');
    }
    for (const candidate of candidates) {
        candidate.probability /= total;
    }

    candidates.sort(
        (left, right) =>
            right.probability - left.probability ||
            left.modelIndex - right.modelIndex
    );

    let cumulative = 0;
    let keepCount = candidates.length;
    if (args.topP < 1) {
        for (let index = 0; index < candidates.length; index += 1) {
            cumulative += candidates[index]!.probability;
            if (cumulative >= args.topP) {
                keepCount = index + 1;
                break;
            }
        }
    }
    const nucleus = candidates.slice(0, keepCount);
    const nucleusTotal = nucleus.reduce(
        (sum, candidate) => sum + candidate.probability,
        0
    );
    for (const candidate of nucleus) {
        candidate.probability /= nucleusTotal;
    }

    const seed = normalizeMaiaSeed(args.seed);
    let cursor = seededRandom(seed);
    let selected = nucleus[nucleus.length - 1]!;
    for (const candidate of nucleus) {
        cursor -= candidate.probability;
        if (cursor < 0) {
            selected = candidate;
            break;
        }
    }

    return {
        moveUci: selected.moveUci,
        modelIndex: selected.modelIndex,
        probability: selected.probability,
        candidateCount: nucleus.length,
        seed,
    };
}
