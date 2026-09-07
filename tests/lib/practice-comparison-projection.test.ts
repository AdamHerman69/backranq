import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import { referenceScoreForPracticeManifest, reviewForPracticeManifest } from '@/lib/training/practiceReview';
import { parsePracticeMomentRevision, type Side } from '@/lib/training/practiceContract';
import { practicePositionFixture } from '../helpers/practice-position';
import { rebuildPracticeFixture } from '../helpers/practice-v4';

function fixture(side: Side = 'WHITE') {
    const best = side === 'WHITE' ? 'e2e4' : 'e7e5';
    const original = side === 'WHITE' ? 'a2a3' : 'a7a6';
    const manifest = practicePositionFixture({ fen: new Chess().fen().replace(' w ', side === 'WHITE' ? ' w ' : ' b '), bestMoveUci: best, originalMoveUci: original });
    manifest.frames[0].model = 'MATCHED_WDL';
    for (const search of Object.values(manifest.evidence.searches)) search.engineIdentity.wdlModel = 'fixture-wdl';
    for (const observation of Object.values(manifest.evidence.observations)) {
        const probe = manifest.evidence.searches[observation.searchId].reason === 'VERIFY_REFERENCE';
        for (const line of observation.lines) {
            line.score = { kind: 'CP', pov: side, cp: line.moveUci === best ? probe ? -58 : -61 : line.moveUci === original ? -141 : -200 };
            line.wdl = line.moveUci === best ? probe ? { win: 100, draw: 690, loss: 210 } : { win: 100, draw: 676, loss: 224 }
                : { win: 0, draw: 41, loss: 959 };
        }
    }
    return parsePracticeMomentRevision(rebuildPracticeFixture(manifest));
}
function review(manifest: ReturnType<typeof fixture>) {
    return reviewForPracticeManifest({ manifest, provider: 'lichess', playedAt: '2026-01-01T00:00:00Z', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], themes: [] });
}

describe('immutable original comparison display', () => {
    it.each(['WHITE', 'BLACK'] as const)('shows the actual cited root baseline consistently with loss metrics for %s', side => {
        const manifest = fixture(side); const before = JSON.stringify(manifest);
        const reference = manifest.assessments.find(a => a.id === manifest.decision.referenceAssessmentId)!;
        expect(reference.score).toEqual({ kind: 'CP', pov: side, cp: -58 });
        const sign = side === 'WHITE' ? 1 : -1;
        const displayed = originalDecisionForPracticeManifest(manifest);
        expect(displayed).toMatchObject({ scoreBefore: { kind: 'cp', pov: 'WHITE', cp: -61 * sign }, scoreAfter: { kind: 'cp', pov: 'WHITE', cp: -141 * sign }, cpLoss: 80 });
        expect(displayed.winChanceLoss).toBeCloseTo(0.4175);
        expect(review(manifest)).toMatchObject({ scoreAtStart: displayed.scoreBefore, originalDecision: displayed });
        expect(JSON.stringify(manifest)).toBe(before);
    });

    it('uses physical ordering and ignores uncited newer roots and partial directional lines', () => {
        const manifest = fixture();
        manifest.evidence.observations = Object.fromEntries(Object.entries(manifest.evidence.observations).reverse());
        expect(referenceScoreForPracticeManifest(manifest)).toMatchObject({ cp: -61 });
        const root = Object.values(manifest.evidence.searches).find(s => s.reason === 'MISSING_REFERENCE')!;
        const point = structuredClone(manifest.evidence.observations[root.observationIds.at(-1)!]);
        point.id = 'uncited'; point.snapshotIndex = 99; point.lines[0].score = { kind: 'CP', pov: 'WHITE', cp: 999 };
        root.observationIds.push(point.id); manifest.evidence.observations[point.id] = point;
        expect(referenceScoreForPracticeManifest(manifest)).toMatchObject({ cp: -61 });
        manifest.assessments.find(a => a.id === manifest.decision.originalAssessmentId)!.observationIds.push(point.id);
        point.bundleComplete = false; point.lines[0].bound = 'UPPER';
        expect(referenceScoreForPracticeManifest(manifest)).toMatchObject({ cp: -61 });
    });

    it('keeps symbolic mate and exact-outcome fallback without synthesizing numeric scores', () => {
        const manifest = fixture();
        const reference = manifest.assessments.find(a => a.id === manifest.decision.referenceAssessmentId)!;
        manifest.assessments.find(a => a.id === manifest.decision.originalAssessmentId)!.observationIds = [];
        reference.score = { kind: 'MATE', pov: 'WHITE', winner: 'WHITE', plies: 3 };
        expect(referenceScoreForPracticeManifest(manifest)).toEqual(reference.score);
        reference.score = { kind: 'EXACT', pov: 'WHITE', outcome: 'WIN', distance: null };
        expect(referenceScoreForPracticeManifest(manifest)).toEqual(reference.score);
        reference.score = { kind: 'CP', pov: 'WHITE', cp: -58 };
        expect(referenceScoreForPracticeManifest(manifest)).toBeNull();
        expect(() => originalDecisionForPracticeManifest(manifest)).toThrow('Original decision scores are missing');
    });
});
