import { describe, expect, it } from 'vitest';
import { reviewWithLocalReference } from '@/lib/hooks/usePuzzleSession';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';
import type { LocalMoveEvaluation } from '@/lib/training/localGrading';

const evaluation: LocalMoveEvaluation = {
    result: { status: 'GRADED', grade: 'BEST', accepted: true },
    source: 'CLIENT_EVALUATED', scoreAfter: { kind: 'cp', cp: 100, pov: 'WHITE' },
    comparison: null, evidence: {},
    clientEvidence: {
        version: 1, contextId: 'later-node', referenceId: 'later-reference',
        policyVersion: 3, tierStable: true,
        localReference: {
            id: 'fresh-later-reference', bestMoveUci: 'a2a3',
            bestScore: { kind: 'cp', cp: 100, pov: 'WHITE' },
            canonicalBestMoveUci: 'b2b3', canonicalScore: { kind: 'cp', cp: 90, pov: 'WHITE' },
            canonicalReferenceOutdated: true,
        },
        metrics: { moveUci: 'a2a3', originalMoveUci: 'b2b3', stable: true, bestGapCp: 0, evidenceModel: 'CP_ONLY' },
        scoreAfter: { kind: 'cp', cp: 100, pov: 'WHITE' }, searches: [],
    },
};

describe('puzzle session root review', () => {
    it('keeps root arrows and scores when a later combination answer has a fresh local reference', () => {
        const root = WARMUP_PUZZLE.prompt.grading.review;
        expect(reviewWithLocalReference(root, evaluation, 1)).toBe(root);
        expect(reviewWithLocalReference(root, evaluation, 2)).toBe(root);
    });
    it('uses the fresh local best move and score for a root answer', () => {
        expect(reviewWithLocalReference(WARMUP_PUZZLE.prompt.grading.review, evaluation, 0)).toMatchObject({
            bestMoveUci: 'a2a3', bestLineUci: ['a2a3'],
            scoreAtStart: { kind: 'cp', cp: 100, pov: 'WHITE' }, acceptedMovesComplete: false,
        });
    });
});
