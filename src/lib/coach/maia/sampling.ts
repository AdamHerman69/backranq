import type { MaiaLegalMove } from '@/lib/coach/maia/preprocess';

export type MaiaPolicySample = MaiaLegalMove & {
    probability: number;
    candidateCount: number;
    seed: number;
};

export type MaiaPolicyCandidate = MaiaLegalMove & {
    probability: number;
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

export function buildMaiaPolicyCandidates(args: {
    logits: ArrayLike<number>;
    legalMoves: readonly MaiaLegalMove[];
    temperature: number;
    topP: number;
}): MaiaPolicyCandidate[] {
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

    return nucleus.map(({ moveUci, modelIndex, probability }) => ({
        moveUci,
        modelIndex,
        probability,
    }));
}

export function sampleWeightedMaiaCandidate<
    T extends { probability: number },
>(
    candidates: readonly T[],
    seedValue: number
): {
    candidate: T;
    probability: number;
    seed: number;
} {
    if (candidates.length === 0) {
        throw new Error('Cannot sample an empty Maia candidate set.');
    }
    let total = 0;
    for (const candidate of candidates) {
        if (
            !Number.isFinite(candidate.probability) ||
            candidate.probability < 0
        ) {
            throw new Error(
                'Maia candidate probability must be finite and non-negative.'
            );
        }
        total += candidate.probability;
    }
    if (!(total > 0) || !Number.isFinite(total)) {
        throw new Error(
            'Maia candidate probabilities must have positive mass.'
        );
    }

    const seed = normalizeMaiaSeed(seedValue);
    let cursor = seededRandom(seed);
    let selected = candidates[candidates.length - 1]!;
    for (const candidate of candidates) {
        cursor -= candidate.probability / total;
        if (cursor < 0) {
            selected = candidate;
            break;
        }
    }

    return {
        candidate: selected,
        probability: selected.probability / total,
        seed,
    };
}

export function sampleMaiaPolicy(args: {
    logits: ArrayLike<number>;
    legalMoves: readonly MaiaLegalMove[];
    seed: number;
    temperature: number;
    topP: number;
}): MaiaPolicySample {
    const candidates = buildMaiaPolicyCandidates(args);
    return sampleMaiaPolicyCandidates(candidates, args.seed);
}

export function sampleMaiaPolicyCandidates(
    candidates: readonly MaiaPolicyCandidate[],
    seed: number
): MaiaPolicySample {
    const selected = sampleWeightedMaiaCandidate(candidates, seed);
    return {
        moveUci: selected.candidate.moveUci,
        modelIndex: selected.candidate.modelIndex,
        probability: selected.probability,
        candidateCount: candidates.length,
        seed: selected.seed,
    };
}
