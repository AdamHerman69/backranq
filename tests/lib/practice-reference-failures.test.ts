import { describe, expect, it } from 'vitest';
import failures from '../fixtures/practice-v4-reference-failures.json';
import { DEFAULT_ASSESSMENT_POLICY, type ComparisonFrame, type EvidenceStore, type Side } from '@/lib/training/practiceContract';
import { createAssessmentEvaluator } from '@/lib/training/assessmentPolicy';

describe('actual optimistic-reference failures, explicit new-policy projection', () => {
    for (const historical of failures.cases) {
        it(`case ${historical.index}: two paid full roots cannot replace the missing focused probe`, () => {
            const evidence = historical.evidence as unknown as EvidenceStore;
            const frame = { ...historical.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
            const evaluate = createAssessmentEvaluator(evidence);
            const input = { frame, trainingSide: historical.source.trainingSide as Side, referenceMoveUci: historical.preferredMoveUci };
            expect(evaluate.referenceReadiness(input)).toMatchObject({ status: 'MISSING_REFERENCE_PROBE', requiredWork: 'REFERENCE_PROBE' });
            for (const moveUci of [historical.preferredMoveUci, historical.source.originalMoveUci]) {
                expect(evaluate(frame, { id: moveUci, moveUci, trainingSide: input.trainingSide,
                    referenceMoveUci: input.referenceMoveUci, originalMoveUci: historical.source.originalMoveUci }).quality).toBe('UNKNOWN');
            }
        });
        if (historical.after400kProbeEvidence) it(`case ${historical.index}: actual completed 400k probe exposes incoherent reference without inventing a final opposite verdict`, () => {
            const frame = { ...historical.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
            const evaluate = createAssessmentEvaluator(historical.after400kProbeEvidence as unknown as EvidenceStore);
            const result = evaluate.referenceReadiness({ frame, trainingSide: historical.source.trainingSide as Side, referenceMoveUci: historical.preferredMoveUci });
            expect(['REFERENCE_VALUE_DRIFT', 'UNRESOLVED_REFERENCE']).toContain(result.status);
            expect(result.requiredWork).toBe('ROOT');
            expect(result.probeSearchId).not.toBeNull();
        });
    }
});
