import { describe, expect, it } from 'vitest';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';

function mixedRevision(clientReference: boolean) {
    const revision = practiceV4Fixture();
    const reference = revision.evidence.searches.search;
    const answer = structuredClone(reference);
    Object.assign(answer, { id: 'answer-search', sequence: 3, observationIds: [] });
    reference.engineIdentity.source = clientReference ? 'CLIENT_ENGINE' : 'SERVER_ENGINE';
    answer.engineIdentity.source = clientReference ? 'SERVER_ENGINE' : 'CLIENT_ENGINE';
    reference.request.multiPv = answer.request.multiPv = 1;
    answer.request.rootScopeUci = ['a2a3'];
    for (const id of reference.observationIds) {
        const point = revision.evidence.observations[id];
        const copy = structuredClone(point);
        Object.assign(copy, { id: `answer-${id}`, searchId: answer.id, rootScopeUci: ['a2a3'], requestedMultiPv: 1, completedSlots: 1 });
        copy.lines = copy.lines.filter(line => line.moveUci === 'a2a3');
        revision.evidence.observations[copy.id] = copy;
        answer.observationIds.push(copy.id);
        point.lines = point.lines.filter(line => line.moveUci === 'e2e4');
        point.requestedMultiPv = point.completedSlots = 1;
    }
    revision.evidence.searches[answer.id] = answer;
    return rebuildPracticeFixture(revision);
}

describe('compute identity and evidence provenance', () => {
    it.each([false, true])('same artifact can combine browser and server evidence (browser reference=%s)', clientReference => {
        const revision = mixedRevision(clientReference);
        const answer = revision.assessments.find(a => a.moveUci === 'a2a3')!;
        expect(answer.qualitySupport).toBe('SUPPORTED');
        expect(answer.source).toBe('CLIENT_ENGINE');
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });

    it('requires an explicit artifact identity', () => {
        const revision = practiceV4Fixture();
        const search = revision.evidence.searches.search as unknown as { engineIdentity: Record<string, unknown> };
        delete search.engineIdentity.artifactId;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/artifactId/);
    });

    it.each(['artifactId', 'build', 'nnue', 'wdlModel'] as const)('provenance equivalence cannot hide an incompatible %s', field => {
        const revision = mixedRevision(false);
        revision.evidence.searches['answer-search'].engineIdentity[field] = 'different-model';
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/incompatible engines/);
    });

    it('provenance equivalence still checks computational options', () => {
        const revision = mixedRevision(false);
        revision.evidence.searches['answer-search'].engineIdentity.options.Hash = 2048;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/incompatible engines/);
    });

    it('server-only proof retains server provenance', () => {
        const revision = practiceV4Fixture();
        expect(revision.assessments.every(a => a.source === 'SERVER_ENGINE')).toBe(true);
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });
});
