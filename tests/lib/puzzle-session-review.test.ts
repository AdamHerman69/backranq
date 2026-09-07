import { expect, it } from 'vitest';
import { reviewWithLocalReference } from '@/lib/hooks/usePuzzleSession';
import { practiceV4Fixture, practiceV4PatchFixture } from '../helpers/practice-v4';
import type { LocalMoveEvaluation } from '@/lib/training/localGrading';
import type { TrainingReviewDto } from '@/lib/training/api';

it('keeps later-node evaluations out of root review, updates a local root reference honestly', () => {
    const review = { bestMoveUci: 'a2a3', bestLineUci: ['a2a3'] } as TrainingReviewDto;
    const manifest = practiceV4Fixture();
    const patch = practiceV4PatchFixture(manifest);
    const evaluation: LocalMoveEvaluation = { result: { status: 'GRADED', quality: 'GOOD', tier: 'GOOD', accepted: true, originalRelation: 'UNKNOWN' },
        source: 'CLIENT_EVALUATED', assessment: patch.assessments[0], patch, refinementNeeded: false, scoreAfter: null, comparison: null };
    expect(reviewWithLocalReference(review, evaluation, 1, manifest)).toBe(review);
    expect(reviewWithLocalReference(review, evaluation, 0, manifest)).toMatchObject({ bestMoveUci: 'e2e4', bestLineUci: ['e2e4'], acceptedMovesComplete: false });
});

it('uses the submitted move’s paid root baseline and PV when the local reference probe has a newer value', async () => {
    const { default: captured } = await import('../fixtures/practice-review-local-reference.json');
    const { parsePracticeMomentRevision, validatePracticeEvaluationPatch } = await import('@/lib/training/practiceContract');
    const manifest = parsePracticeMomentRevision(captured.manifest);
    const patch = captured.patch as unknown as NonNullable<LocalMoveEvaluation['patch']>;
    const assessment = captured.assessment as unknown as NonNullable<LocalMoveEvaluation['assessment']>;
    expect(validatePracticeEvaluationPatch(manifest, patch).success).toBe(true);
    const reference = patch.assessments.find(item => item.id === patch.frame.referenceAssessmentId)!;
    expect(reference.score).toEqual({ kind: 'CP', cp: -39, pov: 'WHITE' });
    expect(assessment.score).toEqual({ kind: 'CP', cp: -68, pov: 'WHITE' });
    expect(assessment.metrics.lossCp).toBe(19);
    const review = { bestMoveUci: 'g1h1', bestLineUci: ['g1h1'], scoreAtStart: { kind: 'cp', cp: 999, pov: 'WHITE' } } as TrainingReviewDto;
    const evaluation: LocalMoveEvaluation = { result: { status: 'GRADED', quality: 'GOOD', tier: assessment.tier, accepted: true, originalRelation: assessment.originalRelation },
        source: 'CLIENT_EVALUATED', assessment, patch, refinementNeeded: false, scoreAfter: { kind: 'cp', cp: -68, pov: 'WHITE' }, comparison: null };
    const before = JSON.stringify({ manifest, evaluation });
    const projected = reviewWithLocalReference(review, evaluation, 0, manifest);
    expect(projected.scoreAtStart).toEqual({ kind: 'cp', cp: -49, pov: 'WHITE' });
    const citedRoot = Object.values(manifest.evidence.observations).find(observation => assessment.observationIds.includes(observation.id)
        && observation.bundleComplete && observation.lines.some(line => line.moveUci === reference.moveUci && line.score.kind === 'CP' && line.score.cp === -49))!;
    expect(citedRoot).toBeDefined();
    expect(patch.evidence.observations[citedRoot.id]).toBeUndefined();
    expect(projected.bestLineUci).toEqual(citedRoot.lines.find(line => line.moveUci === reference.moveUci)!.pvUci);
    expect(JSON.stringify({ manifest, evaluation })).toBe(before);
    // Presentation must not select arbitrary patch dictionary order/context.
    const unrelated = structuredClone(Object.values(patch.evidence.observations)[0]);
    unrelated.id = 'unrelated-display-context'; unrelated.contextId = 'another-context';
    unrelated.lines = [{ moveUci: reference.moveUci, score: { kind: 'CP', cp: 999, pov: 'WHITE' }, bound: 'UNBOUNDED', wdl: null, pvUci: [reference.moveUci, 'a1a1'] }];
    patch.evidence.observations = { ...Object.fromEntries(Object.entries(patch.evidence.observations).reverse()), [unrelated.id]: unrelated };
    expect(reviewWithLocalReference(review, evaluation, 0, manifest)).toEqual(projected);
});
