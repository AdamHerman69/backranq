import { describe, expect, it } from 'vitest';
import { AuditWorkBudget, auditComparatorVerdict, comparatorNeedsReferenceRefresh } from '../../scripts/lib/practice-audit-comparator';

import { assessPracticeReferenceReadiness, type PracticeReferenceReadiness } from '@/lib/training/assessmentPolicy';
import { practiceV4Fixture } from '../helpers/practice-v4';

const good = { quality: 'GOOD', qualitySupport: 'SUPPORTED' } as const;
const below = { quality: 'BELOW_STANDARD', qualitySupport: 'SUPPORTED' } as const;
const provisional = { quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL' } as const;

describe('finite comparator reference authority', () => {
    it('refreshes a provisional reference even without improving drift', () => {
        expect(comparatorNeedsReferenceRefresh(provisional, false)).toBe(true);
        expect(comparatorNeedsReferenceRefresh(undefined, false)).toBe(true);
        expect(comparatorNeedsReferenceRefresh(below, false)).toBe(true);
        expect(comparatorNeedsReferenceRefresh(good, true)).toBe(true);
        expect(comparatorNeedsReferenceRefresh(good, false)).toBe(false);
    });
    it('keeps index-5 style false-GOOD candidates visible while excluding an unproved reference from ground', () => {
        expect(auditComparatorVerdict({ runtimeQuality: 'GOOD', assessment: below, reference: provisional, hasDrift: false, rule: undefined })).toEqual({
            comparatorQuality: 'UNKNOWN', comparatorBasis: 'FINITE_ENGINE', comparatorUnresolvedReason: 'REFERENCE_UNRESOLVED',
            candidateComparatorQuality: 'BELOW_STANDARD', candidateDisagreement: true, disagreement: false,
        });
    });
    it('restores the disagreement only once the reference is proved and not drifting', () => {
        const input = { runtimeQuality: 'GOOD', assessment: below, reference: good, hasDrift: false, rule: undefined };
        expect(auditComparatorVerdict(input)).toMatchObject({ comparatorQuality: 'BELOW_STANDARD', disagreement: true, comparatorUnresolvedReason: null });
        expect(auditComparatorVerdict({ ...input, hasDrift: true })).toMatchObject({ comparatorQuality: 'UNKNOWN', comparatorUnresolvedReason: 'REFERENCE_DRIFT', candidateDisagreement: true });
        expect(auditComparatorVerdict({ ...input, assessment: provisional })).toMatchObject({ comparatorQuality: 'UNKNOWN', comparatorUnresolvedReason: 'MOVE_UNRESOLVED' });
    });
    it('keeps independent RULE ground despite an unresolved finite reference', () => {
        expect(auditComparatorVerdict({ runtimeQuality: 'GOOD', assessment: good, reference: provisional, hasDrift: true, rule: below })).toMatchObject({
            comparatorQuality: 'BELOW_STANDARD', comparatorBasis: 'RULE', comparatorUnresolvedReason: null, disagreement: true, candidateDisagreement: false,
        });
    });
});


describe('bounded readiness-driven audit work', () => {
    const state = (work: PracticeReferenceReadiness['requiredWork'], move = 'e2e4'): PracticeReferenceReadiness => ({
        status: work ? 'UNRESOLVED_REFERENCE' : 'READY', requiredWork: work, preferredMoveUci: move,
        rootSearchId: 'root', probeSearchId: null, contextId: 'context', frameId: 'frame', evidenceIds: [], counterEvidenceIds: [],
    });
    const budget = (maximumRequestedNodes = 30_000_000) => new AuditWorkBudget({ root: [1_600_000, 3_200_000, 6_400_000],
        probe: [1_600_000, 3_200_000, 6_400_000], move: [800_000, 1_600_000], maximumRequestedNodes });
    it('follows the new dependency after each completion without consuming another ladder', () => {
        const work = budget();
        expect(work.takeReference(null)).toMatchObject({ kind: 'ROOT', nodes: 1_600_000, moveUci: null });
        expect(work.takeReference(state('REFERENCE_PROBE'))).toMatchObject({ kind: 'REFERENCE_PROBE', nodes: 1_600_000, moveUci: 'e2e4' });
        expect(work.takeReference(state('ROOT'))).toMatchObject({ kind: 'ROOT', nodes: 3_200_000 });
        // New root changes preferred: follow helper's probe request, not another root.
        expect(work.takeReference(state('REFERENCE_PROBE', 'd2d4'))).toMatchObject({ kind: 'REFERENCE_PROBE', nodes: 3_200_000, moveUci: 'd2d4' });
        expect(work.takeReference(state(null))).toBeNull();
        expect(work.take('MOVE', 'a2a3')).toMatchObject({ kind: 'MOVE', nodes: 800_000 });
        expect(work.take('MOVE', 'a2a3')).toMatchObject({ kind: 'MOVE', nodes: 1_600_000 });
        expect(work.take('MOVE', 'b2b3')).toMatchObject({ kind: 'MOVE', nodes: 800_000 });
    });
    it('reuses an eligible all-legal singleton regardless of its historical reason', () => {
        const manifest = practiceV4Fixture(); manifest.evidence.searches['reference-probe'].reason = 'MISSING_MOVE';
        const readiness = assessPracticeReferenceReadiness({ evidence: manifest.evidence, frame: manifest.frames[0],
            trainingSide: manifest.source.trainingSide, referenceMoveUci: manifest.rootAnswerIndex.preferredMoveUci, policy: manifest.policySnapshot });
        expect(readiness).toMatchObject({ status: 'READY', probeSearchId: 'reference-probe' });
        const work = budget(); expect(work.takeReference(readiness)).toBeNull();
        expect(work.report()).toMatchObject({ physicalReservations: 0, requestedNodes: 0 });
        manifest.evidence.searches['reference-probe'].completion = 'STOPPED';
        const missing = assessPracticeReferenceReadiness({ evidence: manifest.evidence, frame: manifest.frames[0],
            trainingSide: manifest.source.trainingSide, referenceMoveUci: manifest.rootAnswerIndex.preferredMoveUci, policy: manifest.policySnapshot });
        expect(work.takeReference(missing)).toMatchObject({ kind: 'REFERENCE_PROBE', nodes: 1_600_000 });
    });
    it('terminates oscillating references within the global probe ladder and declared total', () => {
        const work = budget(22_400_000);
        for (let i = 0; i < 3; i++) { expect(work.takeReference(state('ROOT'))).not.toBeNull(); expect(work.takeReference(state('REFERENCE_PROBE', i % 2 ? 'd2d4' : 'e2e4'))).not.toBeNull(); }
        expect(work.takeReference(state('REFERENCE_PROBE', 'g1f3'))).toBeNull();
        expect(work.report()).toMatchObject({ requestedNodes: 22_400_000, physicalReservations: 6, stopReason: 'REFERENCE_PROBE_LADDER_EXHAUSTED' });
        expect(work.take('MOVE', 'a2a3')).toBeNull();
        expect(work.report().stopReason).toBe('NODE_BUDGET_EXHAUSTED');
    });
    it('capture root/probe/original requests remain independent under the original aggregate ceiling', () => {
        const work = new AuditWorkBudget({ root: [200_000, 400_000, 800_000], probe: [400_000, 800_000], move: [200_000, 400_000, 800_000], maximumRequestedNodes: 2_800_000 });
        expect(work.takeReference(null)?.nodes).toBe(200_000);
        expect(work.takeReference(state('REFERENCE_PROBE'))?.nodes).toBe(400_000);
        expect(work.take('MOVE', 'a2a3')?.nodes).toBe(200_000);
        expect(work.take('MOVE', 'a2a3')?.nodes).toBe(400_000);
        expect(work.takeReference(state('ROOT'))?.nodes).toBe(400_000);
        expect(work.takeReference(state('REFERENCE_PROBE'))?.nodes).toBe(800_000);
        expect(work.take('MOVE', 'a2a3')).toBeNull();
        expect(work.report()).toMatchObject({ requestedNodes: 2_400_000, stopReason: 'NODE_BUDGET_EXHAUSTED' });
    });
});
