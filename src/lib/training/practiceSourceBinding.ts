import { EXTRACTION_CONFIG_VERSION } from '@/lib/analysis/extractionConfig';
import { canonicalJson, type PracticeMomentRevision } from './practiceContract';
import { originalComparisonForPracticeManifest, practiceScoreToWhitePov } from './practiceReview';

/** Derived display columns are never a second authority for the original decision. */
export function originalDecisionForPracticeManifest(manifest: PracticeMomentRevision) {
    const original = originalComparisonForPracticeManifest(manifest);
    const scoreBefore = practiceScoreToWhitePov(original.referenceScore);
    const scoreAfter = practiceScoreToWhitePov(original.originalScore);
    if (!scoreBefore || !scoreAfter) throw new Error('Original decision scores are missing');
    return { scoreBefore, scoreAfter,
        ...(original?.metrics.lossCp != null ? { cpLoss: Math.max(0, original.metrics.lossCp) } : {}),
        ...(original?.metrics.lossExpectedScore != null ? { winChanceLoss: Math.max(0, original.metrics.lossExpectedScore) } : {}) };
}

export function practiceProfileMatchesConfig(manifest: PracticeMomentRevision, configHash: string, snapshot: unknown): boolean {
    if (!snapshot || typeof snapshot !== 'object') return false;
    // Browser runs store the extraction snapshot directly. Server runs store
    // that same snapshot inside their execution/billing envelope.
    if ('extraction' in snapshot) {
        if ('extractor' in snapshot || !('executionMode' in snapshot) ||
            snapshot.executionMode !== 'SERVER_QUEUE' || !('version' in snapshot) ||
            snapshot.version !== EXTRACTION_CONFIG_VERSION) return false;
        snapshot = snapshot.extraction;
        if (!snapshot || typeof snapshot !== 'object' || !('version' in snapshot) ||
            snapshot.version !== EXTRACTION_CONFIG_VERSION) return false;
    }
    if (!('extractor' in snapshot)) return false;
    const extractor = snapshot.extractor;
    if (!extractor || typeof extractor !== 'object' || !('confirmNodes' in extractor) || !('gradingPolicy' in extractor) || !('selectionPolicyId' in extractor)) return false;
    const minimum = extractor.confirmNodes === null ? 1 : extractor.confirmNodes;
    return typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum > 0
        && manifest.executionProfileId === configHash
        && manifest.executionProfileSnapshot.minimumConfirmationNodes === minimum
        && manifest.selection.policyId === extractor.selectionPolicyId
        && canonicalJson(manifest.policySnapshot) === canonicalJson(extractor.gradingPolicy);
}
