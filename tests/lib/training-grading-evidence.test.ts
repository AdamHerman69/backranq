import { describe, expect, it } from 'vitest';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { assessMove, expectedScore, normalizeScore } from '@/lib/training/assessmentPolicy';
import type { PracticeMomentRevision } from '@/lib/training/practiceContract';

function assess(revision: PracticeMomentRevision) {
    return assessMove(revision.frames[0], { id: 'answer', moveUci: 'd2d4', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', trainingSide: 'WHITE', evidence: revision.evidence });
}
describe('v4 compatible engine evidence', () => {
    it('derives expected score from actual win/draw/loss counts', () => {
        expect(expectedScore({ win: 500, draw: 400, loss: 100 })).toBe(0.7);
        expect(() => expectedScore({ win: 0, draw: 0, loss: 0 })).toThrow();
        expect(() => expectedScore({ win: -1, draw: 1000, loss: 1 })).toThrow();
    });
    it('requires compatible WDL even when cp evaluations are equal', () => {
        const revision = practiceV4Fixture(); revision.frames[0].model = 'MATCHED_WDL';
        for (const search of Object.values(revision.evidence.searches)) search.engineIdentity.wdlModel = 'stockfish-18';
        for (const observation of Object.values(revision.evidence.observations)) {
            observation.lines[0].wdl = { win: 900, draw: 100, loss: 0 };
            if (observation.lines[1]) observation.lines[1].wdl = { win: 400, draw: 100, loss: 500 };
            if (observation.lines[1]) observation.lines[1].score = structuredClone(observation.lines[0].score);
        }
        expect(assess(revision).quality).toBe('BELOW_STANDARD');
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].wdl = null;
        expect(assess(revision).quality).toBe('UNKNOWN');
    });
    it('explicit CP_ONLY has no synthetic expected score or exact outcome', () => {
        const result = assess(practiceV4Fixture());
        expect(result.quality).toBe('GOOD'); expect(result.metrics.lossExpectedScore).toBeNull(); expect(result.metrics.preservesExactOutcome).toBeNull();
    });
    it('never mixes exact/tablebase scores with engine CP under a claimed WDL comparison', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) observation.lines[0].score = { kind: 'EXACT', outcome: 'WIN', pov: 'WHITE', distance: 3 };
        expect(assess(revision).quality).toBe('UNKNOWN');
    });
    it('mixed cp/mate needs a shared supported basis even for a large apparent loss', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'MATE', winner: 'BLACK', plies: 7, pov: 'WHITE' };
        expect(assess(revision).quality).toBe('UNKNOWN');
        expect(assess(revision).metrics.lossCp).toBeNull();
    });
    it('preserves the identity of mate winner when normalizing perspective', () => {
        expect(normalizeScore({ kind: 'MATE', winner: 'BLACK', plies: 4, pov: 'BLACK' }, 'WHITE')).toEqual({ kind: 'MATE', winner: 'BLACK', plies: 4, pov: 'WHITE' });
        expect(normalizeScore({ kind: 'EXACT', outcome: 'WIN', distance: 5, pov: 'BLACK' }, 'WHITE')).toEqual({ kind: 'EXACT', outcome: 'LOSS', distance: 5, pov: 'WHITE' });
    });
    it('incompatible engine fingerprints do not contribute extra convergence observations', () => {
        const revision = practiceV4Fixture();
        revision.evidence.observations['observation-0'].engineFingerprint = 'other-engine';
        expect(assess(revision).quality).toBe('UNKNOWN');
    });
});
