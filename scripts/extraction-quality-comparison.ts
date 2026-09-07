import { lookupAnswer } from '@/lib/training/answerIndex';
import type { PracticeMomentRevision, Quality } from '@/lib/training/practiceContract';

export type RootAnswerSnapshot = {
    bestMoveUci: string;
    acceptedMovesUci: string[];
    belowStandardMovesUci: string[];
    unknownMovesUci: string[];
};

/** Input is the extractor's validated immutable revision; only its current root counts. */
export function snapshotRootAnswers(manifest: PracticeMomentRevision): RootAnswerSnapshot {
    const index = manifest.rootAnswerIndex;
    const frame = manifest.frames.find(candidate => candidate.id === index.frameId);
    const qualities = index.legalMovesUci.map(move => [move, frame
        ? lookupAnswer(index, move, manifest.assessments, manifest.coverageGroups, frame).quality
        : 'UNKNOWN'] as const);
    const moves = (quality: Quality) => qualities.filter(([, found]) => found === quality).map(([move]) => move).sort();
    return { bestMoveUci: index.preferredMoveUci, acceptedMovesUci: moves('GOOD'),
        belowStandardMovesUci: moves('BELOW_STANDARD'), unknownMovesUci: moves('UNKNOWN') };
}

function qualityOf(snapshot: RootAnswerSnapshot, move: string): Quality {
    if (snapshot.acceptedMovesUci.includes(move)) return 'GOOD';
    if (snapshot.belowStandardMovesUci.includes(move)) return 'BELOW_STANDARD';
    return 'UNKNOWN';
}

export function compareRootAnswers(product: RootAnswerSnapshot, reference: RootAnswerSnapshot) {
    const productQualityOfReferenceBest = qualityOf(product, reference.bestMoveUci);
    const referenceQualityOfProductBest = qualityOf(reference, product.bestMoveUci);
    const bestMoveCompatibility = productQualityOfReferenceBest === 'BELOW_STANDARD' || referenceQualityOfProductBest === 'BELOW_STANDARD'
        ? 'INCOMPATIBLE' : productQualityOfReferenceBest === 'GOOD' && referenceQualityOfProductBest === 'GOOD'
            ? 'COMPATIBLE' : 'UNKNOWN';
    const union = new Set([...product.acceptedMovesUci, ...reference.acceptedMovesUci]);
    const supportedQualityOppositionMovesUci = [...union].filter(move =>
        qualityOf(product, move) === 'BELOW_STANDARD' || qualityOf(reference, move) === 'BELOW_STANDARD').sort();
    return {
        productBestMoveUci: product.bestMoveUci, referenceBestMoveUci: reference.bestMoveUci,
        exactBestMove: product.bestMoveUci === reference.bestMoveUci,
        productQualityOfReferenceBest, referenceQualityOfProductBest, bestMoveCompatibility,
        // Descriptive overlap of known GOOD sets, not an accuracy or disagreement rate.
        acceptedMoveJaccard: union.size === 0 ? 1 : product.acceptedMovesUci.filter(move => reference.acceptedMovesUci.includes(move)).length / union.size,
        supportedQualityOppositionMovesUci,
    };
}

export function summarizeRootComparisons(details: ReturnType<typeof compareRootAnswers>[]) {
    const compatible = details.filter(row => row.bestMoveCompatibility === 'COMPATIBLE').length;
    const incompatible = details.filter(row => row.bestMoveCompatibility === 'INCOMPATIBLE').length;
    const unknown = details.filter(row => row.bestMoveCompatibility === 'UNKNOWN').length;
    const countQualities = (qualities: Quality[]) => ({
        GOOD: qualities.filter(quality => quality === 'GOOD').length,
        BELOW_STANDARD: qualities.filter(quality => quality === 'BELOW_STANDARD').length,
        UNKNOWN: qualities.filter(quality => quality === 'UNKNOWN').length,
    });
    return {
        bestMoveCompatibility: compatible + incompatible === 0 ? null : compatible / (compatible + incompatible),
        bestMoveCompatibilityCounts: { compatible, incompatible, unknown, resolved: compatible + incompatible, total: details.length },
        productQualityOfReferenceBestCounts: countQualities(details.map(row => row.productQualityOfReferenceBest)),
        referenceQualityOfProductBestCounts: countQualities(details.map(row => row.referenceQualityOfProductBest)),
    };
}
