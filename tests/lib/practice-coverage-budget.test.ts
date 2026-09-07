import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { supplementPracticeCoverage } from '@/lib/analysis/practiceCoverage';
import { assessPracticePosition } from '@/lib/analysis/practiceMomentBuilder';
import { DEFAULT_ASSESSMENT_POLICY } from '@/lib/training/practiceContract';
import { ScriptedExtractionEngine } from '../helpers/extraction-engine';

it.each([
    { confirmationNodes: 200_000, mate: false, expectedCoverageNodes: null },
    { confirmationNodes: 500_000, mate: false, expectedCoverageNodes: 100_000 },
    { confirmationNodes: 200_000, mate: true, expectedCoverageNodes: 40_000 },
])('only prepays coverage that can contribute mature evidence: %j', async ({ confirmationNodes, mate, expectedCoverageNodes }) => {
    const fen = new Chess().fen();
    const engine = new ScriptedExtractionEngine().set(fen, [
        { move: 'e2e4', ...(mate ? { mate: 1 } : { cp: 200 }) },
        { move: 'd2d4', ...(mate ? { mate: 2 } : { cp: 180 }) },
        { move: 'g1f3', ...(mate ? { mate: 3 } : { cp: 150 }) },
        { move: 'c2c4', ...(mate ? { mate: -2 } : { cp: 0 }) },
        { move: 'a2a3', ...(mate ? { mate: -1 } : { cp: -400 }) },
    ]);
    const pool = new PositionAnalysisPool();
    const wrapped = pool.wrap(engine);
    await wrapped.analyzeMultiPv({ fen, nodes: confirmationNodes, multiPv: 5, purpose: 'MISSING_REFERENCE' });
    if (!mate) await wrapped.analyzeMultiPv({ fen, nodes: confirmationNodes, multiPv: 5, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
    if (!mate) await wrapped.evalPosition({ fen, nodes: 400_000, rootMoves: ['e2e4'], purpose: 'VERIFY_REFERENCE', reuse: 'FRESH_REQUIRED' });
    // The mandatory focused reference proof is real paid work. The optional
    // allowance conservatively uses the existing root/original-search budget.
    expect(pool.report().requestedNodes).toBe(mate ? confirmationNodes : 2 * confirmationNodes + 400_000);
    const args = { pool, engine: wrapped, fen, positionHistory: [], trainingSide: 'WHITE' as const,
        originalMoveUci: 'a2a3', minimumConfirmationNodes: 200_000, policy: DEFAULT_ASSESSMENT_POLICY, timeoutMs: 2_000 };
    const before = assessPracticePosition(args)!;
    expect(before.decision.selection).toBe('INCLUDED');
    expect(before.rootAnswerIndex.unresolvedMovesUci.length).toBeGreaterThan(3);
    await supplementPracticeCoverage(args);
    const queries = engine.requests.filter(request => request.purpose === 'OPTIONAL_COVERAGE');
    if (expectedCoverageNodes === null) expect(queries).toHaveLength(0);
    else {
        expect(queries).toHaveLength(1);
        expect(queries[0]).toMatchObject({ nodes: expectedCoverageNodes, multiPv: 3,
            rootMoves: before.rootAnswerIndex.unresolvedMovesUci });
        if (!mate) {
            const after = assessPracticePosition(args)!;
            const optionalIds = new Set(Object.values(after.evidence.searches).filter(search => search.reason === 'OPTIONAL_COVERAGE').map(search => search.id));
            const measured = Object.values(after.evidence.observations).filter(observation => optionalIds.has(observation.searchId)).flatMap(observation => observation.lines.map(line => line.moveUci));
            expect(measured.length).toBeGreaterThan(0);
            // One paid physical group is an anchor for a future real answer,
            // never a claimed finite verdict for a previously unseen move.
            for (const moveUci of new Set(measured)) expect(after.assessments.find(assessment => assessment.moveUci === moveUci)?.quality).toBe('UNKNOWN');
        }
        await supplementPracticeCoverage(args);
        expect(engine.requests.filter(request => request.purpose === 'OPTIONAL_COVERAGE')).toHaveLength(1);
    }
});
