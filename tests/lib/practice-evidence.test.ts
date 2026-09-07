import { Chess } from 'chess.js';
import { expect, it } from 'vitest';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { assessPracticePosition } from '@/lib/analysis/practiceMomentBuilder';
import { createBoundAnalysisSnapshot, resolveEngineSearchContext } from '@/lib/analysis/stockfishClient';
import { ScriptedExtractionEngine } from '../helpers/extraction-engine';

it('keeps an actual native directional counter through pool and canonical projection', async () => {
    const fen = new Chess().fen();
    const engine = new ScriptedExtractionEngine().set(fen, [
        { move: 'e2e3', cp: 100 }, { move: 'd2d3', cp: 95 }, { move: 'e2e4', cp: -200 },
    ]);
    const pool = new PositionAnalysisPool();
    await pool.wrap(engine).analyzeMultiPv({ fen, nodes: 200_000, multiPv: 3, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
    const result = await pool.wrap(engine).analyzeMultiPv({ fen, nodes: 200_000, multiPv: 3, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
    await pool.wrap(engine).analyzeMultiPv({ fen, rootMoves: ['e2e3'], nodes: 400_000, multiPv: 1, purpose: 'VERIFY_REFERENCE', reuse: 'FRESH_REQUIRED' });
    const args = { pool, fen, positionHistory: [], trainingSide: 'WHITE' as const, originalMoveUci: 'e2e4', minimumConfirmationNodes: 200_000 };
    expect(assessPracticePosition(args)?.assessments.find(a => a.moveUci === 'd2d3')).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });

    const limit = { fen, nodes: 400_000, multiPv: 3, purpose: 'OPTIONAL_COVERAGE' };
    const snapshot = createBoundAnalysisSnapshot('actual-counter', 0, result.identity!, resolveEngineSearchContext(limit), limit,
        [{ multipv: 1, score: { type: 'cp', value: -300 }, bound: 'UPPER', depth: 14, pvUci: ['d2d3'], nodes: 100, timeMs: 2,
            wdl: { win: 0, draw: 0, loss: 1000 } }], 'counter-session')!;
    pool.recordSnapshot(snapshot);
    const projected = assessPracticePosition(args)!;
    expect(projected.evidence.observations[snapshot.id]).toMatchObject({ bundleComplete: false, requestedMultiPv: 3, completedSlots: 1,
        lines: [{ moveUci: 'd2d3', bound: 'UPPER', score: { kind: 'CP', cp: -300, pov: 'WHITE' }, wdl: null }] });
    expect(projected.assessments.find(a => a.moveUci === 'd2d3')?.qualitySupport).not.toBe('SUPPORTED');
    expect(projected.rootAnswerIndex.unresolvedMovesUci).toContain('d2d3');
    expect(projected.decision.status).toBe('CONFIRMED_MISTAKE');
});
