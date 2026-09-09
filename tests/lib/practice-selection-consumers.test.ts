import { describe, expect, it } from 'vitest';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { deriveT2Selection } from '@/lib/training/selectionPolicy';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';
import { originalDecisionForPracticeManifest, practiceProfileMatchesConfig } from '@/lib/training/practiceSourceBinding';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import { isTrainableSolution } from '@/lib/training/contracts';

function selectedPending() {
    const manifest = practiceV4Fixture();
    for (const id of ['reference-probe', 'corroborating-search']) {
        for (const observationId of manifest.evidence.searches[id].observationIds) delete manifest.evidence.observations[observationId];
        delete manifest.evidence.searches[id];
    }
    rebuildPracticeFixture(manifest);
    manifest.selection = deriveT2Selection(manifest, { referenceSearchId: 'search', comparisonBasis: 'SAME_ROOT', preferredMoveUci: 'e2e4' });
    manifest.semanticHash = solutionSemanticsHash({ manifest, configHash: manifest.executionProfileId });
    return manifest;
}

describe('Practice selection consumers', () => {
    it('serves a selected moment and its original comparison before answer grades are ready', () => {
        const manifest = selectedPending();
        expect(manifest.decision).toMatchObject({ status: 'UNRESOLVED', selection: 'OMITTED' });
        expect(isTrainableSolution({ manifest, configHash: manifest.executionProfileId })).toBe(true);
        const prompt = toTrainingPromptDto({
            id: manifest.momentId, gameId: manifest.source.gameId, decisionPly: manifest.source.decisionPly,
            sideToMove: 'w', originalMoveUci: manifest.source.originalMoveUci, sourceKinds: ['MY_MISTAKE'],
            lessonKinds: [], themes: [], game: { provider: 'CHESSCOM', playedAt: new Date('2026-09-01T00:00:00Z') },
            fen: manifest.source.fen, positionHistory: manifest.source.positionHistory,
            currentSolutionRevisionId: manifest.revisionId, currentSolutionRevision: { manifest, trainable: true },
        });
        expect(prompt.grading.selection.status).toBe('INCLUDED');
        expect(prompt.review.originalDecision).toMatchObject({
            scoreBefore: { kind: 'cp', cp: 30, pov: 'WHITE' }, scoreAfter: { kind: 'cp', cp: -200, pov: 'WHITE' }, cpLoss: 230,
        });
    });

    it('retains source/config binding while selection and grading policies are separate', () => {
        const manifest = selectedPending();
        const extractor = { confirmNodes: 100_000, gradingPolicy: manifest.policySnapshot, selectionPolicyId: manifest.selection.policyId };
        expect(practiceProfileMatchesConfig(manifest, manifest.executionProfileId, { extractor })).toBe(true);
        expect(practiceProfileMatchesConfig(manifest, manifest.executionProfileId, { extractor: { ...extractor, selectionPolicyId: 'untrusted' } })).toBe(false);
        expect(practiceProfileMatchesConfig(manifest, 'different-config', { extractor })).toBe(false);
    });

    it('normalizes selection CP and WDL to the player for losses and White for display', () => {
        const manifest = selectedPending();
        manifest.source.trainingSide = 'BLACK';
        const comparison = manifest.selection.comparison!;
        comparison.referenceScore = { kind: 'CP', cp: -100, pov: 'WHITE' };
        comparison.originalScore = { kind: 'CP', cp: 150, pov: 'WHITE' };
        comparison.referenceWdl = { win: 0, draw: 600, loss: 400 };
        comparison.originalWdl = { win: 600, draw: 400, loss: 0 };
        expect(originalDecisionForPracticeManifest(manifest)).toEqual({
            scoreBefore: { kind: 'cp', cp: -100, pov: 'WHITE' }, scoreAfter: { kind: 'cp', cp: 150, pov: 'WHITE' },
            cpLoss: 250, winChanceLoss: 0.5,
        });
    });
});
