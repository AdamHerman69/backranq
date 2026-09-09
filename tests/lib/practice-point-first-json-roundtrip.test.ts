import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAssessmentEvaluator } from '@/lib/training/assessmentPolicy';
import { canonicalJson, parsePracticeMomentRevision } from '@/lib/training/practiceContract';

/** Models the observed Prisma create transport: 16 significant decimal digits
 * and PostgreSQL JSONB dictionary order. No database or engine is needed. */
function jsonTransport(value: unknown): unknown {
    if (typeof value === 'number') return Number(value.toPrecision(16));
    if (Array.isArray(value)) return value.map(jsonTransport);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
        .map(([key, item]) => [key, jsonTransport(item)]));
    return value;
}

describe('real point-first assessment JSON persistence', () => {
    it('reproduces the lost numeric tails and keeps canonical derived metrics stable through JSON transport', () => {
        expect(jsonTransport(0.020999999999999963)).toBe(0.02099999999999996);
        expect(jsonTransport(0.10100000000000003)).toBe(0.101);
        const fixture = JSON.parse(readFileSync('tests/fixtures/practice-t2-real.json', 'utf8'));
        const manifest = parsePracticeMomentRevision(fixture.manifest);
        const assessment = manifest.assessments.find(item => item.moveUci === 'd1d3')!;
        expect(assessment.metrics).toMatchObject({ lossExpectedScore: 0.021, recoveredExpectedScore: 0.101 });
        const transported = parsePracticeMomentRevision(JSON.parse(JSON.stringify(jsonTransport(manifest))));
        expect(canonicalJson(transported)).toBe(canonicalJson(manifest));
        const evaluate = createAssessmentEvaluator(transported.evidence);
        for (const expected of transported.assessments) {
            const frame = transported.frames.find(frame => frame.id === expected.frameId)!;
            const reference = transported.assessments.find(item => item.id === frame.referenceAssessmentId)!;
            expect(evaluate(frame, { id: expected.id, moveUci: expected.moveUci, trainingSide: transported.source.trainingSide,
                referenceMoveUci: reference.moveUci, originalMoveUci: transported.source.originalMoveUci }, transported.policySnapshot)).toEqual(expected);
        }
        // Normalizing derived storage values never turns validation into approximate approval.
        transported.assessments.find(item => item.moveUci === 'd1d3')!.metrics.lossExpectedScore = 0.0211;
        expect(() => parsePracticeMomentRevision(transported)).toThrow('not implied by its evidence');
    });
});
