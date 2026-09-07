import { canonicalJson, type PracticeMomentRevision } from './practiceContract';
import { practiceScoreToWhitePov, referenceScoreForPracticeManifest } from './practiceReview';

/** Derived display columns are never a second authority for the original decision. */
export function originalDecisionForPracticeManifest(manifest: PracticeMomentRevision) {
    const original = manifest.assessments.find(a => a.id === manifest.decision.originalAssessmentId);
    const scoreBefore = practiceScoreToWhitePov(referenceScoreForPracticeManifest(manifest));
    const scoreAfter = practiceScoreToWhitePov(original?.score ?? null);
    if (!scoreBefore || !scoreAfter) throw new Error('Original decision scores are missing');
    return { scoreBefore, scoreAfter,
        ...(original?.metrics.lossCp != null ? { cpLoss: Math.max(0, original.metrics.lossCp) } : {}),
        ...(original?.metrics.lossExpectedScore != null ? { winChanceLoss: Math.max(0, original.metrics.lossExpectedScore) } : {}) };
}

export function practiceProfileMatchesConfig(manifest: PracticeMomentRevision, configHash: string, snapshot: unknown): boolean {
    if (!snapshot || typeof snapshot !== 'object' || !('extractor' in snapshot)) return false;
    const extractor = snapshot.extractor;
    if (!extractor || typeof extractor !== 'object' || !('confirmNodes' in extractor) || !('gradingPolicy' in extractor)) return false;
    const minimum = extractor.confirmNodes === null ? 1 : extractor.confirmNodes;
    return typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum > 0
        && manifest.executionProfileId === configHash
        && manifest.executionProfileSnapshot.minimumConfirmationNodes === minimum
        && canonicalJson(manifest.policySnapshot) === canonicalJson(extractor.gradingPolicy);
}
