import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectPaidComparator } from '../../scripts/lib/practice-audit-reuse';
import { canonicalJson, DEFAULT_ASSESSMENT_POLICY, type EvidenceStore, type PracticeMomentRevision } from '@/lib/training/practiceContract';
import { practiceV4Fixture } from '../helpers/practice-v4';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function input(manifest = practiceV4Fixture()) {
    const rawEvidenceJson = JSON.stringify(manifest.evidence);
    return { rawEvidenceJson, baseEvidenceSha256: digest(rawEvidenceJson), baseRunFingerprint: 'a'.repeat(64),
        baseSource: structuredClone(manifest.source), source: structuredClone(manifest.source),
        expectedEngineIdentity: structuredClone(manifest.evidence.searches.search.engineIdentity), minimumConfirmationNodes: 100_000 };
}
function modified(change: (evidence: EvidenceStore) => void) {
    const fixture = practiceV4Fixture(); change(fixture.evidence); return input(fixture);
}
function quality(manifest: PracticeMomentRevision, move: string) { return manifest.assessments.find(a => a.moveUci === move)!.quality; }

describe('current-policy paid comparator projection', () => {
    it('derives the same labels from physical order and preserves all bytes and inputs', () => {
        const fixture = practiceV4Fixture(); const args = input(fixture); const before = canonicalJson(args);
        const result = projectPaidComparator(args);
        expect(result.reusableGround).toBe(true);
        expect(result.readiness).toMatchObject({ status: 'READY', rootSearchId: 'search', probeSearchId: 'reference-probe' });
        for (const old of fixture.assessments) {
            const actual = result.manifest.assessments.find(a => a.moveUci === old.moveUci)!;
            for (const key of ['quality', 'qualitySupport', 'tier', 'tierSupport', 'originalRelation', 'metrics'] as const) expect(actual[key]).toEqual(old[key]);
        }
        expect(canonicalJson(result.manifest.evidence)).toBe(canonicalJson(fixture.evidence));
        expect(canonicalJson(args)).toBe(before);
        expect(result.manifest.rootAnswerIndex.legalMovesUci).toHaveLength(20);
        expect(result.newWork).toEqual({ physicalSearches: 0, requestedNodes: 0 });
        expect(result.retainedEvidenceCost).toMatchObject({ physicalSearches: 3, requestedNodes: 600_000, reportedNodes: 600_000 });
        expect(result.provenance.baseEvidenceSha256).toBe(digest(args.rawEvidenceJson));
    });
    it('ignores old labels and computes with the explicitly current policy', () => {
        const fixture = practiceV4Fixture(); const args = input(fixture);
        fixture.assessments.forEach(a => { a.quality = 'BELOW_STANDARD'; });
        fixture.rootAnswerIndex.preferredMoveUci = 'a2a3'; fixture.policyId = 'obsolete-policy';
        const current = projectPaidComparator(input(fixture));
        expect(current.manifest.rootAnswerIndex.preferredMoveUci).toBe('e2e4');
        expect(quality(current.manifest, 'd2d4')).toBe('GOOD');
        const stricter = projectPaidComparator({ ...args, policy: { ...DEFAULT_ASSESSMENT_POLICY, id: 'audit-stricter-maturity', latestSupportNodes: 200_000 } });
        expect(stricter.manifest.policyId).toBe('audit-stricter-maturity');
        expect(quality(stricter.manifest, 'd2d4')).toBe('UNKNOWN');
        expect(stricter.reusableGround).toBe(false);
    });
    it('preserves an active reference bound and refuses ground rather than clearing counterevidence', () => {
        const args = modified(evidence => {
            const search = evidence.searches['reference-probe'];
            const counter = structuredClone(evidence.observations[search.observationIds.at(-1)!]);
            counter.id = 'active-reference-bound'; counter.snapshotIndex++; counter.depth++;
            counter.bundleComplete = false; counter.lines[0].bound = 'UPPER';
            counter.lines[0].score = { kind: 'CP', cp: -100, pov: 'WHITE' };
            search.observationIds.push(counter.id); evidence.observations[counter.id] = counter;
        });
        const result = projectPaidComparator(args);
        expect(result.reusableGround).toBe(false);
        expect(result.readiness.status).not.toBe('READY');
        expect(result.manifest.evidence.observations['active-reference-bound'].lines[0].bound).toBe('UPPER');
        expect(canonicalJson(result.manifest.evidence)).toBe(canonicalJson(JSON.parse(args.rawEvidenceJson)));
    });
    it('retains STOPPED physical searches and never counts them as new work', () => {
        const args = modified(evidence => { evidence.searches['corroborating-search'].completion = 'STOPPED'; });
        const result = projectPaidComparator(args);
        expect(result.manifest.evidence.searches['corroborating-search'].completion).toBe('STOPPED');
        expect(canonicalJson(result.manifest.evidence)).toBe(canonicalJson(JSON.parse(args.rawEvidenceJson)));
        expect(quality(result.manifest, 'd2d4')).toBe('UNKNOWN');
        expect(result.newWork.physicalSearches).toBe(0);
    });
    it('allows the same compute identity across runtime provenance without relabelling saved evidence', () => {
        const args = input(); args.expectedEngineIdentity.source = 'CLIENT_ENGINE'; args.expectedEngineIdentity.options.MultiPV = 5;
        const result = projectPaidComparator(args);
        expect(result.reusableGround).toBe(true);
        expect(Object.values(result.manifest.evidence.searches).every(s => s.engineIdentity.source === 'SERVER_ENGINE')).toBe(true);
    });
    it.each(['game', 'history', 'context'] as const)('rejects a changed full source identity: %s', field => {
        const args = input();
        if (field === 'game') args.source.gameId = 'another-game';
        if (field === 'history') args.source.positionHistory.push(args.source.fen);
        if (field === 'context') args.source.contextId = 'another-context';
        expect(() => projectPaidComparator(args)).toThrow(/source identity/);
    });
    it.each(['artifact', 'nnue', 'options', 'wdl', 'fingerprint'] as const)('rejects a different current compute identity: %s', field => {
        const args = input();
        if (field === 'artifact') args.expectedEngineIdentity.artifactId = 'other-artifact';
        if (field === 'nnue') args.expectedEngineIdentity.nnue = 'other-network';
        if (field === 'options') args.expectedEngineIdentity.options.Hash = 256;
        if (field === 'wdl') args.expectedEngineIdentity.wdlModel = 'other-model';
        if (field === 'fingerprint') args.expectedEngineIdentity.fingerprint = 'other-fingerprint';
        expect(() => projectPaidComparator(args)).toThrow(/compute identity/);
    });
    it.each(['scope', 'pv', 'sequence', 'binding'] as const)('validates all raw evidence rather than trusting IDs: %s', field => {
        const args = modified(evidence => {
            if (field === 'scope') evidence.searches.search.request.rootScopeUci = ['a1a1'];
            if (field === 'pv') evidence.observations['observation-0'].lines[0].pvUci = ['e2e4', 'a1a1'];
            if (field === 'sequence') evidence.searches.search.sequence = evidence.searches['corroborating-search'].sequence;
            if (field === 'binding') evidence.searches.search.request.positionHistory = [evidence.searches.search.request.fen];
        });
        expect(() => projectPaidComparator(args)).toThrow();
    });
    it('rejects modified raw bytes even when JSON meaning is unchanged', () => {
        const args = input(); args.rawEvidenceJson += ' ';
        expect(() => projectPaidComparator(args)).toThrow(/immutable audit provenance/);
    });
});
