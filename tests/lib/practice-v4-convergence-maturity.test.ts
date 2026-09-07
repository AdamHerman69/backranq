import { describe, expect, it } from 'vitest';
import index27 from '../fixtures/practice-v4-maturity-index27.json';
import mate from '../fixtures/practice-v4-low-node-mate.json';
import coldB1 from '../fixtures/practice-v4-cold-first-d2b1.json';
import coldF1 from '../fixtures/practice-v4-cold-first-d2f1.json';
import { assessMove } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, type ComparisonFrame, type EvidenceStore } from '@/lib/training/practiceContract';
import { createAnalysisSnapshot, createSearchEvidence, resolveEngineSearchContext, type MultiPvLine } from '@/lib/analysis/stockfishClient';
import { practiceEvidenceFromSnapshots } from '@/lib/analysis/practiceEvidence';

const actualMateEvidence = () => {
    const searches = mate.searches.map(trace => {
        const options = { fen: trace.request.fen, previousFens: [], rootMoves: 'rootMoves' in trace.request ? trace.request.rootMoves : undefined,
            nodes: trace.request.maxNodes, multiPv: trace.request.multiPv, purpose: 'MISSING_MOVE' as const };
        const context = resolveEngineSearchContext(options);
        return { snapshots: trace.snapshots.map(s => createAnalysisSnapshot(trace.request.id, s.snapshot.snapshotIndex,
            { ...mate.identity, artifactId: 'historical-diagnostic-artifact-unverified' }, context, options, s.snapshot.lines as MultiPvLine[], s.sessionId)!),
            completion: createSearchEvidence(trace.request.id, { ...mate.identity, artifactId: 'historical-diagnostic-artifact-unverified' }, context, options,
                { nodes: trace.done.final.nodes, timeMs: trace.done.final.timeMs }, trace.done.sessionId) };
    });
    const evidence = practiceEvidenceFromSnapshots(searches.flatMap(s => s.snapshots), 'WHITE', searches.map(s => s.completion));
    const first = Object.values(evidence.observations)[0];
    const frame: ComparisonFrame = { id: 'actual-mate', contextId: first.contextId, engineFingerprint: first.engineFingerprint,
        policyId: DEFAULT_ASSESSMENT_POLICY.id, model: 'MATCHED_WDL', referenceAssessmentId: 'ref', status: 'CURRENT', supersededById: null };
    return { evidence, frame };
};
describe('both mature convergence anchors and solved symbolic mate', () => {
    it.each([coldB1, coldF1])('rejects cold first-choice false GOOD for $moveUci and resolves its stronger pair', trace => {
        const frame = { ...trace.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
        const input = { id: trace.moveUci, moveUci: trace.moveUci, trainingSide: 'WHITE' as const,
            referenceMoveUci: trace.referenceMoveUci, originalMoveUci: trace.source.originalMoveUci };
        expect(trace.prematurePair.every(point => point.nodes >= 25_000)).toBe(true);
        expect(trace.prematurePair.at(-1)!.nodes).toBeLessThan(100_000);
        expect(assessMove(frame, { ...input, evidence: trace.prematureEvidence as EvidenceStore }))
            .toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL', score: { kind: 'CP', cp: trace.prematureCp } });
        expect(assessMove(frame, { ...input, evidence: trace.matureEvidence as EvidenceStore }))
            .toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL', score: { kind: 'CP', cp: trace.matureCp } });
    });
    it('rejects actual index27 false GOOD with a 3187-node anchor and accepts its later stable BELOW', () => {
        const frame = { ...index27.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
        const input = { id: 'index27', moveUci: 'g1f2', trainingSide: 'WHITE' as const,
            referenceMoveUci: 'b5b6', originalMoveUci: index27.source.originalMoveUci };
        const premature = assessMove(frame, { ...input, evidence: index27.prematureEvidence as EvidenceStore });
        expect(premature).toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL', score: { kind: 'CP', cp: 151 } });
        expect(Object.values(index27.prematureEvidence.observations).some(o => o.nodes === 3187)).toBe(true);
        const mature = assessMove(frame, { ...input, evidence: index27.matureEvidence as EvidenceStore });
        expect(mature).toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL', score: { kind: 'CP', cp: 56 } });
    });
    it('accepts real low-node WASM mate1/mate2 convergence as ENGINE evidence', () => {
        const { evidence, frame } = actualMateEvidence();
        const result = assessMove(frame, { id: 'mate2', moveUci: 'f7e7', trainingSide: 'WHITE', referenceMoveUci: 'f7g7', originalMoveUci: 'f7e6', evidence });
        expect(result).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED', source: 'CLIENT_ENGINE', score: { kind: 'MATE', winner: 'WHITE' } });
        expect(Object.values(evidence.searches).map(s => s.reportedNodes)).toEqual([6373, 736]);
        expect(Object.values(evidence.exact)).toEqual([]);
        // The exception cannot be borrowed by CP/WDL predictions with the same counts.
        for (const observation of Object.values(evidence.observations)) for (const line of observation.lines) line.score = { kind: 'CP', cp: 200, pov: 'WHITE' };
        expect(assessMove(frame, { id: 'cp', moveUci: 'f7e7', trainingSide: 'WHITE', referenceMoveUci: 'f7g7', originalMoveUci: 'f7e6', evidence }).quality).toBe('UNKNOWN');
    });
    it('low-node mating points still need winner convergence and obey partial counters', () => {
        const { evidence, frame } = actualMateEvidence();
        const moveSearch = Object.values(evidence.searches)[1]; const points = moveSearch.observationIds.map(id => evidence.observations[id]);
        const input = { id: 'mate', moveUci: 'f7e7', trainingSide: 'WHITE' as const, referenceMoveUci: 'f7g7', originalMoveUci: 'f7e6', evidence };
        points[0].lines[0].score = { kind: 'MATE', winner: 'BLACK', plies: 4, pov: 'WHITE' };
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
        points[0].lines[0].score = { kind: 'MATE', winner: 'WHITE', plies: 3, pov: 'WHITE' };
        const counter = structuredClone(points.at(-1)!);
        Object.assign(counter, { id: 'mate-counter', snapshotIndex: counter.snapshotIndex + 1, bundleComplete: false, nodes: 1 });
        counter.lines[0].bound = 'UPPER'; counter.lines[0].score = { kind: 'MATE', winner: 'BLACK', plies: 4, pov: 'WHITE' };
        moveSearch.observationIds.push(counter.id); evidence.observations[counter.id] = counter;
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
});
