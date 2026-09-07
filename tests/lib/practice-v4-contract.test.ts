import { describe, expect, it } from 'vitest';
import { practiceV4Fixture, practiceV4PatchFixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { practicePositionFixture } from '../helpers/practice-position';
import { canonicalPracticeSemantics, parsePracticeMomentRevision, validatePracticeEvaluationPatch, validatePracticeMomentRevision } from '@/lib/training/practiceContract';
import { deriveAnswerIndex, lookupAnswer } from '@/lib/training/answerIndex';

describe('strict Practice v4 contract', () => {
    it('requires the new latest-strength field and its registered value', () => {
        const revision = practiceV4Fixture();
        const missing = structuredClone(revision) as unknown as { policySnapshot: Record<string, unknown> };
        delete missing.policySnapshot.latestSupportNodes;
        expect(() => parsePracticeMomentRevision(missing)).toThrow(/latestSupportNodes/);
        revision.policySnapshot.latestSupportNodes = 50_000;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/Policy snapshot does not match its registered ID/);
    });
    it('requires mature actual root evidence for a verified opponent transition', () => {
        const revision = practicePositionFixture({ fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2', originalMoveUci: 'f1c4', bestMoveUci: 'g1f3', continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'f1b5' } });
        const opponent = revision.continuation.nodes.find(node => node.role === 'OPPONENT')!;
        // Automatic opponent edges use root observations directly, without a USER answer index.
        revision.assessments = revision.assessments.filter(a => a.contextId !== opponent.contextId);
        revision.frames = revision.frames.filter(frame => frame.contextId !== opponent.contextId);
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
        const search = Object.values(revision.evidence.searches).find(s => s.contextId === opponent.contextId)!;
        const points = Object.values(revision.evidence.observations).filter(o => o.searchId === search.id);
        search.reportedNodes = 10; points.forEach(point => { point.nodes = 10; });
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/Opponent transition lacks stable complete root evidence/);
        search.reportedNodes = 100_000;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/Opponent transition lacks stable complete root evidence/);
        points.at(-1)!.nodes = 25_000;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/Opponent transition lacks stable complete root evidence/);
        points[0].nodes = 25_000;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/Opponent transition lacks stable complete root evidence/);
        points.at(-1)!.nodes = 100_000;
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });

    it.each([['UPPER', -300, true], ['LOWER', 300, true], ['LOWER', -50, false]] as const)('opponent transition respects current partial %s %i bounds', (bound, cp, contradiction) => {
        const revision = practicePositionFixture({ fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2', originalMoveUci: 'f1c4', bestMoveUci: 'g1f3', continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'f1b5' } });
        const opponent = revision.continuation.nodes.find(node => node.role === 'OPPONENT')!;
        revision.assessments = revision.assessments.filter(a => a.contextId !== opponent.contextId);
        revision.frames = revision.frames.filter(frame => frame.contextId !== opponent.contextId);
        const search = Object.values(revision.evidence.searches).find(s => s.contextId === opponent.contextId)!;
        const latest = revision.evidence.observations[search.observationIds.at(-1)!];
        const counter = structuredClone(latest);
        Object.assign(counter, { id: 'opponent-counter', snapshotIndex: latest.snapshotIndex + 1, depth: latest.depth + 1, nodes: 10, bundleComplete: false, completedSlots: 1 });
        counter.lines = [{ ...counter.lines[0], bound, score: { kind: 'CP', cp, pov: 'WHITE' } }];
        revision.evidence.observations[counter.id] = counter; search.observationIds.push(counter.id);
        if (contradiction) expect(() => parsePracticeMomentRevision(revision)).toThrow(/Opponent transition has contradictory current bounds/);
        else expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
        const fresh = structuredClone(latest); Object.assign(fresh, { id: 'opponent-fresh', snapshotIndex: counter.snapshotIndex + 1, depth: counter.depth + 1 });
        revision.evidence.observations[fresh.id] = fresh; search.observationIds.push(fresh.id);
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });

    it.each([false, true])('reference confirmation budget requires full-root scope (full=%s)', fullReference => {
        const revision = practiceV4Fixture(); const base = revision.evidence.searches.search;
        // Deliberate synthetic node overshoot isolates requested-profile scope
        // from actual quality maturity, which is independently 100k latest.
        base.request.limit.nodes = 25_000;
        for (const [index, moveUci] of ['e2e4', 'a2a3'].entries()) {
            const search = structuredClone(base); search.id = `high-${moveUci}`; search.sequence = index + 3;
            search.request.limit.nodes = search.reportedNodes = 100_000; search.request.multiPv = 1;
            search.request.rootScopeUci = fullReference && moveUci === 'e2e4' ? [...base.request.rootScopeUci] : [moveUci];
            const observation = structuredClone(revision.evidence.observations['observation-2']);
            Object.assign(observation, { id: `high-point-${moveUci}`, searchId: search.id, snapshotIndex: 0, depth: 14, nodes: 100_000,
                requestedMultiPv: 1, completedSlots: 1, rootScopeUci: [...search.request.rootScopeUci] });
            observation.lines = observation.lines.filter(line => line.moveUci === moveUci);
            search.observationIds = [];
            for (let pointIndex = 0; pointIndex < 3; pointIndex++) {
                const point = structuredClone(observation);
                Object.assign(point, { id: `${observation.id}-${pointIndex}`, snapshotIndex: pointIndex, depth: 14 + pointIndex, nodes: [25_000, 50_000, 100_000][pointIndex] });
                search.observationIds.push(point.id); revision.evidence.observations[point.id] = point;
            }
            revision.evidence.searches[search.id] = search;
        }
        rebuildPracticeFixture(revision);
        expect(revision.assessments.find(a => a.moveUci === 'a2a3')?.qualitySupport).toBe('SUPPORTED');
        expect(revision.assessments.find(a => a.moveUci === 'e2e4')?.qualitySupport).toBe('SUPPORTED');
        expect(revision.decision.status).toBe(fullReference ? 'CONFIRMED_MISTAKE' : 'UNRESOLVED');
        expect(revision.decision.selection).toBe(fullReference ? 'INCLUDED' : 'OMITTED');
        expect(validatePracticeMomentRevision(revision).success).toBe(true);
    });

    it('accepts incomplete bound-only counterevidence but never incomplete point evidence', () => {
        const revision = practiceV4Fixture(); const observation = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(observation, { id: 'bound-counter', snapshotIndex: 3, depth: 13, nodes: 100_000, bundleComplete: false, completedSlots: 1 });
        observation.lines = [{ ...observation.lines[1], bound: 'UPPER', score: { kind: 'CP', cp: -200, pov: 'WHITE' } }];
        revision.evidence.observations[observation.id] = observation; revision.evidence.searches.search.observationIds.push(observation.id);
        rebuildPracticeFixture(revision);
        expect(revision.assessments.find(a => a.moveUci === 'd2d4')?.quality).toBe('UNKNOWN');
        expect(validatePracticeMomentRevision(revision).success).toBe(true);
        observation.lines[0].bound = 'UNBOUNDED'; rebuildPracticeFixture(revision);
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });

    it.each([['d2d4', 'UPPER', -200], ['a2a3', 'LOWER', 200]] as const)('rejects old support after newer contradictory %s bound', (moveUci, bound, cp) => {
        const revision = practiceV4Fixture();
        const observation = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(observation, { id: 'new-bound', snapshotIndex: 3, depth: 13, nodes: 100_000 });
        Object.assign(observation.lines.find(line => line.moveUci === moveUci)!, { bound, score: { kind: 'CP', cp, pov: 'WHITE' } });
        revision.evidence.observations[observation.id] = observation; revision.evidence.searches.search.observationIds.push(observation.id);
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
        rebuildPracticeFixture(revision);
        expect(revision.assessments.find(a => a.moveUci === moveUci)?.quality).toBe('UNKNOWN');
        expect(validatePracticeMomentRevision(revision).success).toBe(true);
    });
    it('rejects a coverage group that cherry-picks old proof while newer evidence vetoes its conclusion', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -150, pov: 'WHITE' };
        revision.coverageGroups = [{ id: 'old-boundary', contextId: revision.source.contextId, frameId: revision.frames[0].id,
            movesUci: ['d2d4'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: Object.keys(revision.evidence.observations) }];
        rebuildPracticeFixture(revision); expect(validatePracticeMomentRevision(revision).success).toBe(true);
        const newer = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(newer, { id: 'new-point', snapshotIndex: 3, depth: 13, nodes: 100_000 });
        newer.lines[1].score = { kind: 'CP', cp: 20, pov: 'WHITE' };
        revision.evidence.observations[newer.id] = newer; revision.evidence.searches.search.observationIds.push(newer.id);
        rebuildPracticeFixture(revision);
        expect(revision.assessments.find(a => a.moveUci === 'd2d4')?.quality).toBe('UNKNOWN');
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });

    it('validates a partial moment with genuine supported alternatives and zero projection searches', () => {
        const revision = practiceV4Fixture();
        expect(validatePracticeMomentRevision(revision)).toEqual({ success: true, value: revision });
        expect(revision.decision.status).toBe('CONFIRMED_MISTAKE');
        expect(revision.decision.selection).toBe('INCLUDED');
        expect(revision.rootAnswerIndex.readiness).toBe('PARTIAL');
        expect(lookupAnswer(revision.rootAnswerIndex, 'd2d4', revision.assessments, []).quality).toBe('GOOD');
        expect(lookupAnswer(revision.rootAnswerIndex, 'b1c3', revision.assessments, []).kind).toBe('PENDING');
        expect(lookupAnswer(revision.rootAnswerIndex, 'a1a8', revision.assessments, []).kind).toBe('ILLEGAL');
    });
    it.each([
        ['legacy field', (r: ReturnType<typeof practiceV4Fixture>) => Object.assign(r, { acceptedMovesUci: ['e2e4'] })],
        ['missing nullable field', (r: ReturnType<typeof practiceV4Fixture>) => Reflect.deleteProperty(r.assessments[0].metrics, 'lossCp')],
        ['false full coverage', (r: ReturnType<typeof practiceV4Fixture>) => { r.rootAnswerIndex.readiness = 'ALL_MOVES_CLASSIFIED'; r.rootAnswerIndex.unresolvedMovesUci = []; }],
        ['support forged from rank', (r: ReturnType<typeof practiceV4Fixture>) => { r.assessments[2].quality = 'GOOD'; }],
        ['duplicate snapshot vote', (r: ReturnType<typeof practiceV4Fixture>) => { r.evidence.observations['observation-2'].snapshotIndex = 1; }],
        ['wrong history', (r: ReturnType<typeof practiceV4Fixture>) => { r.evidence.searches.search.request.positionHistory = [r.source.fen]; }],
        ['illegal PV', (r: ReturnType<typeof practiceV4Fixture>) => { r.evidence.observations['observation-0'].lines[0].pvUci = ['e2e4', 'e7e4']; }],
        ['unregistered policy mutation', (r: ReturnType<typeof practiceV4Fixture>) => { r.policySnapshot.maxExpectedScoreLoss = 0.9; }],
        ['confirmation budget shortcut', (r: ReturnType<typeof practiceV4Fixture>) => { r.executionProfileSnapshot.minimumConfirmationNodes = 200_000; }],
    ])('rejects %s', (_name, mutate) => { const revision = practiceV4Fixture(); mutate(revision); expect(validatePracticeMomentRevision(revision).success).toBe(false); });
    it('does not create semantic changes from physical IDs or wall time', () => {
        const a = practiceV4Fixture(); const b = structuredClone(a);
        b.momentId = 'new'; b.revisionId = 'other'; b.evidence.searches.search.reportedTimeMs += 100;
        b.frames[0].id = 'new-frame'; b.rootAnswerIndex.frameId = 'new-frame';
        for (const assessment of b.assessments) assessment.frameId = 'new-frame';
        expect(canonicalPracticeSemantics(b)).toEqual(canonicalPracticeSemantics(a));
        b.assessments[1].metrics.lossCp = 15;
        expect(canonicalPracticeSemantics(b)).not.toEqual(canonicalPracticeSemantics(a));
    });
    it('accepts an independently supported client patch but rejects evidence overwrites', () => {
        const revision = practiceV4Fixture(); const patch = practiceV4PatchFixture(revision);
        expect(validatePracticeEvaluationPatch(revision, patch)).toEqual({ success: true, value: patch });
        patch.evidence.searches.search = structuredClone(revision.evidence.searches.search);
        patch.evidence.searches.search.reportedNodes++;
        expect(validatePracticeEvaluationPatch(revision, patch).success).toBe(false);
    });
    it('accepts enrichment on a prepared continuation USER context but rejects opponent and terminal contexts', () => {
        const revision = practicePositionFixture({ fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2', originalMoveUci: 'f1c4', bestMoveUci: 'g1f3', continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'f1b5' } });
        const user = revision.continuation.nodes.find(node => node.role === 'USER' && node.contextId !== revision.source.contextId)!;
        const frame = revision.frames.find(item => item.id === user.answerIndex!.frameId)!;
        const patch = { frame, assessments: revision.assessments.filter(item => item.frameId === frame.id), evidence: { searches: {}, observations: {}, exact: {} } };
        expect(validatePracticeEvaluationPatch(revision, patch).success).toBe(true);
        for (const role of ['OPPONENT', 'TERMINAL'] as const) {
            const contextId = revision.continuation.nodes.find(node => node.role === role)!.contextId;
            expect(validatePracticeEvaluationPatch(revision, { ...patch, frame: { ...frame, id: `new-${role}`, contextId } }).success).toBe(false);
        }
        const unprepared = structuredClone(revision); unprepared.continuation.nodes.find(node => node.contextId === user.contextId)!.answerIndex = null;
        expect(validatePracticeEvaluationPatch(unprepared, patch).success).toBe(false);
    });
    it('rejects GOOD and below-standard coverage overlap', () => {
        const revision = practiceV4Fixture();
        expect(() => deriveAnswerIndex({ contextId: revision.source.contextId, frameId: 'frame', preferredMoveUci: 'e2e4', legalMovesUci: revision.rootAnswerIndex.legalMovesUci, assessments: revision.assessments, coverageGroups: [{ id: 'bad-group', contextId: revision.source.contextId, frameId: 'frame', movesUci: ['d2d4'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: ['observation-2'] }] })).toThrow(/contradicts/);
    });
    it('requires the authoritative profile budget to match the snapshot', () => {
        expect(() => parsePracticeMomentRevision(practiceV4Fixture(), { minimumConfirmationNodes: 200_000 })).toThrow(/authoritative/);
    });
});
