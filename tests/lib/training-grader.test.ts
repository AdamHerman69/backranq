import { describe, expect, it } from 'vitest';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { assessMove } from '@/lib/training/assessmentPolicy';
import type { PracticeMomentRevision } from '@/lib/training/practiceContract';

function grade(revision: PracticeMomentRevision, moveUci: string, originalMoveUci = revision.source.originalMoveUci) {
    return assessMove(revision.frames[0], { id: 'test-assessment', moveUci, originalMoveUci, referenceMoveUci: 'e2e4', trainingSide: 'WHITE', evidence: revision.evidence }, revision.policySnapshot);
}
describe('v4 shared grading separates quality, tier and original identity', () => {
    it('a repeated original move can itself be GOOD', () => {
        const revision = practiceV4Fixture(); const result = grade(revision, 'e2e4', 'e2e4');
        expect(result.quality).toBe('GOOD'); expect(result.tier).toBe('BEST'); expect(result.originalRelation).toBe('SAME_MOVE');
    });
    it('equivalent good alternatives do not require exact bestmove identity', () => {
        const result = grade(practiceV4Fixture(), 'd2d4');
        expect(result.quality).toBe('GOOD'); expect(result.qualitySupport).toBe('SUPPORTED');
    });
    it('a meaningful improvement can remain BELOW_STANDARD', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) {
            if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -200, pov: 'WHITE' };
            if (observation.lines[2]) observation.lines[2].score = { kind: 'CP', cp: -500, pov: 'WHITE' };
        }
        const result = grade(revision, 'd2d4');
        expect(result.quality).toBe('BELOW_STANDARD'); expect(result.originalRelation).toBe('BETTER');
        expect(result.tier).toBe('SUBPAR'); expect(result.metrics.recoveredCp).toBe(300);
    });
    it('reports repeated and different mistakes through independent originalRelation', () => {
        const revision = practiceV4Fixture();
        expect(grade(revision, 'a2a3').originalRelation).toBe('SAME_MOVE');
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -500, pov: 'WHITE' };
        const result = grade(revision, 'd2d4');
        expect(result.quality).toBe('BELOW_STANDARD'); expect(result.originalRelation).toBe('WORSE');
    });
    it('does not call missing or unstable evidence a wrong answer', () => {
        const revision = practiceV4Fixture();
        expect(grade(revision, 'b1c3').quality).toBe('UNKNOWN');
        revision.evidence.observations = { 'observation-2': revision.evidence.observations['observation-2'] };
        expect(grade(revision, 'a2a3').quality).toBe('UNKNOWN');
    });
    it('accepts saturated winning positions within adaptive cp tolerance', () => {
        const revision = practiceV4Fixture(); revision.frames[0].model = 'MATCHED_WDL';
        for (const search of Object.values(revision.evidence.searches)) search.engineIdentity.wdlModel = 'stockfish-18';
        for (const observation of Object.values(revision.evidence.observations)) {
            observation.lines[0].score = { kind: 'CP', cp: 1000, pov: 'WHITE' };
            if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: 800, pov: 'WHITE' };
            for (const line of observation.lines) line.wdl = { win: 1000, draw: 0, loss: 0 };
        }
        expect(grade(revision, 'd2d4').quality).toBe('GOOD');
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: 500, pov: 'WHITE' };
        expect(grade(revision, 'd2d4').quality).toBe('BELOW_STANDARD');
    });
});
