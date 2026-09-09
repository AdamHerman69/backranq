import { describe, expect, it } from 'vitest';
import { assessMove, assessPracticeReferenceReadiness } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, T2_ASSESSMENT_POLICY, T2_STRICT_ASSESSMENT_POLICY, T2_LENIENT_ASSESSMENT_POLICY } from '@/lib/training/practiceContract';
import { deriveAnswerIndex, lookupAnswer, observedAnswerRank } from '@/lib/training/answerIndex';
import { practiceV4Fixture } from '../helpers/practice-v4';

function fixture() {
    const revision = practiceV4Fixture();
    revision.policyId = T2_ASSESSMENT_POLICY.id; revision.policySnapshot = { ...T2_ASSESSMENT_POLICY };
    revision.frames[0].policyId = revision.policyId;
    const point = revision.evidence.observations['observation-2']; point.nodes = 60_000;
    revision.evidence.observations = { [point.id]: point };
    const search = revision.evidence.searches.search; search.observationIds = [point.id];
    revision.evidence.searches = { search };
    return revision;
}
function grade(revision: ReturnType<typeof fixture>, moveUci: string) {
    return assessMove(revision.frames[0], { id: `answer-${moveUci}`, moveUci, trainingSide: revision.source.trainingSide,
        referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence }, revision.policySnapshot);
}
function focused(revision: ReturnType<typeof fixture>, cp: number, completion: 'COMPLETED' | 'STOPPED' = 'COMPLETED') {
    const search = structuredClone(revision.evidence.searches.search);
    search.id = `focused-${Object.keys(revision.evidence.searches).length}`; search.sequence += Object.keys(revision.evidence.searches).length;
    search.request.rootScopeUci = ['a2a3']; search.request.multiPv = 1; search.completion = completion;
    const point = structuredClone(revision.evidence.observations['observation-2']);
    point.id = `${search.id}-point`; point.searchId = search.id; point.rootScopeUci = ['a2a3']; point.requestedMultiPv = 1; point.completedSlots = 1;
    point.lines = [{ ...point.lines[2], score: { kind: 'CP', cp, pov: 'WHITE' } }];
    search.observationIds = [point.id]; revision.evidence.searches[search.id] = search; revision.evidence.observations[point.id] = point;
}

describe('point-first Practice answers', () => {
    it('uses a single real completed 60k iteration from a 100k root without a preferred probe', () => {
        const revision = fixture();
        expect(assessPracticeReferenceReadiness({ evidence: revision.evidence, frame: revision.frames[0], trainingSide: 'WHITE', referenceMoveUci: 'e2e4', policy: revision.policySnapshot })).toMatchObject({ status: 'READY', probeSearchId: null });
        expect(grade(revision, 'e2e4')).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED', tier: 'BEST' });
        expect(grade(revision, 'd2d4')).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        expect(grade(revision, 'a2a3')).toMatchObject({ quality: 'BELOW_STANDARD', qualitySupport: 'SUPPORTED' });
        revision.policySnapshot = { ...DEFAULT_ASSESSMENT_POLICY }; revision.frames[0].policyId = DEFAULT_ASSESSMENT_POLICY.id;
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
    });
    it('does not manufacture maturity, completion, coverage or a negative top-K verdict', () => {
        const revision = fixture();
        const assessments = ['e2e4', 'd2d4', 'a2a3', 'g1f3'].map(move => grade(revision, move));
        const index = deriveAnswerIndex({ contextId: revision.source.contextId, frameId: revision.frames[0].id, legalMovesUci: revision.rootAnswerIndex.legalMovesUci,
            preferredMoveUci: 'e2e4', assessments, coverageGroups: [] });
        expect(lookupAnswer(index, 'g1f3', assessments, []).kind).toBe('PENDING');
        expect(observedAnswerRank(index, 'g1f3', revision)).toEqual({ rank: null, lineCount: 3, observationId: 'observation-2' });
        expect(observedAnswerRank(index, 'd2d4', revision)?.rank).toBe(2);
        revision.evidence.searches.search.completion = 'STOPPED';
        expect(observedAnswerRank(index, 'g1f3', revision)).toBeNull();
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
        revision.evidence.searches.search.completion = 'COMPLETED'; revision.evidence.observations['observation-2'].nodes = 24_999;
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
    });
    it('keeps a boundary pending, resolves from one focused point, and withdraws on a contradictory unfinished tail', () => {
        const revision = fixture(); revision.evidence.observations['observation-2'].lines[2].score = { kind: 'CP', cp: -60, pov: 'WHITE' };
        expect(grade(revision, 'a2a3')).toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL' });
        focused(revision, -200);
        expect(grade(revision, 'a2a3').quality).toBe('BELOW_STANDARD');
        focused(revision, 20, 'STOPPED');
        expect(grade(revision, 'a2a3').quality).toBe('UNKNOWN');
    });
    it('vetoes a stale recommendation when a newer compatible answer materially beats it', () => {
        const revision = fixture(); focused(revision, 180);
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
        expect(grade(revision, 'a2a3').quality).toBe('UNKNOWN');
    });
    it('normalizes score POV before comparing', () => {
        const revision = fixture();
        for (const line of revision.evidence.observations['observation-2'].lines) if (line.score.kind === 'CP') line.score = { ...line.score, cp: -line.score.cp, pov: 'BLACK' };
        expect(grade(revision, 'a2a3')).toMatchObject({ quality: 'BELOW_STANDARD', metrics: { lossCp: 230 } });
    });
    it('uses real matched WDL for mixed CP/mate without inventing CP or exact evidence', () => {
        const revision = fixture(); revision.frames[0].model = 'MATCHED_WDL'; revision.evidence.searches.search.engineIdentity.wdlModel = 'real-model';
        const lines = revision.evidence.observations['observation-2'].lines;
        lines[0].score = { kind: 'MATE', plies: 5, winner: 'WHITE', pov: 'WHITE' }; lines[0].wdl = { win: 1000, draw: 0, loss: 0 };
        lines[1].score = { kind: 'CP', cp: 200, pov: 'WHITE' }; lines[1].wdl = { win: 900, draw: 100, loss: 0 };
        lines[2].wdl = { win: 0, draw: 0, loss: 1000 };
        expect(grade(revision, 'd2d4')).toMatchObject({ quality: 'GOOD', score: { kind: 'CP' }, metrics: { lossCp: null, lossExpectedScore: 0.05 } });
        expect(grade(revision, 'a2a3')).toMatchObject({ quality: 'BELOW_STANDARD' });
        for (const wdl of [{ win: 999, draw: 1, loss: 0 }, { win: 0, draw: 0, loss: 1000 }, { win: 0, draw: 1000, loss: 0 }]) {
            lines[0].wdl = wdl;
            expect(grade(revision, 'd2d4').quality).toBe('UNKNOWN');
        }
        lines[0].wdl = { win: 1000, draw: 0, loss: 0 };
        lines[1].wdl = null;
        expect(grade(revision, 'd2d4').quality).toBe('UNKNOWN');
    });
    it.each([T2_STRICT_ASSESSMENT_POLICY, T2_LENIENT_ASSESSMENT_POLICY])('keeps point-first readiness for registered tolerance variant $id', policy => {
        const revision = fixture(); revision.policySnapshot = { ...policy }; revision.frames[0].policyId = revision.policySnapshot.id;
        expect(grade(revision, 'e2e4').quality).toBe('GOOD');
        revision.policySnapshot.id += ':unregistered'; revision.frames[0].policyId = revision.policySnapshot.id;
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
    });
    it('normalizes output metrics only after resolving raw grading boundaries', () => {
        const revision = fixture();
        revision.frames[0].model = 'MATCHED_WDL'; revision.evidence.searches.search.engineIdentity.wdlModel = 'real-model';
        revision.policySnapshot.expectedScoreSupportMargin = 0;
        const lines = revision.evidence.observations['observation-2'].lines;
        lines[0].wdl = { win: 550, draw: 0, loss: 450 };
        lines[1].wdl = { win: 449.99999999996, draw: 0, loss: 550.00000000004 };
        const assessment = grade(revision, 'd2d4');
        expect(assessment.metrics.lossExpectedScore).toBe(0.1);
        expect(assessment.quality).toBe('BELOW_STANDARD');
    });
    it('does not combine different WDL models or an invalid mate-zero recommendation', () => {
        const revision = fixture(); focused(revision, -200);
        revision.evidence.searches['focused-1'].engineIdentity.wdlModel = 'other-model';
        expect(grade(revision, 'a2a3').quality).toBe('UNKNOWN');
        revision.evidence.observations['observation-2'].lines[0].score = { kind: 'MATE', plies: 0, winner: 'WHITE', pov: 'WHITE' };
        expect(grade(revision, 'e2e4').quality).toBe('UNKNOWN');
    });
});
