import { CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { extractTrainingMomentsFromGames, tacticalMoveFacts, type TrainingMomentExtractionOptions } from '@/lib/analysis/extractTrainingMoments';
import { parseExtractionCheckpoint } from '@/lib/analysis/extractionCheckpoint';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import { lookupAnswer } from '@/lib/training/answerIndex';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import type { NormalizedGame } from '@/lib/types/game';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';
import { claimableDraw, ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';

const START = new Chess().fen();
const options: TrainingMomentExtractionOptions = { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, multiPv: 3, returnAnalysis: true };
function game(pgn: string, id = 'fixture', side: 'white' | 'black' | 'unknown' = 'white'): NormalizedGame {
    return { id, provider: 'lichess', playedAt: '2026-01-01T00:00:00.000Z', timeClass: 'rapid', white: { name: side === 'white' ? 'adam' : 'opponent' }, black: { name: side === 'black' ? 'adam' : 'opponent' }, pgn, provenance: { username: 'adam', userSide: side } };
}
function quietEngine(): ScriptedExtractionEngine {
    return new ScriptedExtractionEngine().set(START, [{ move: 'e2e3', cp: 100 }, { move: 'd2d3', cp: 95 }, { move: 'e2e4', cp: -200 }])
        .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: 200 }]);
}
function run(engine = quietEngine(), source = game('1. e4 *'), extra: Partial<Parameters<typeof extractTrainingMomentsFromGames>[0]> = {}) {
    return extractTrainingMomentsFromGames({ engine, games: [source], selectedGameIds: new Set([source.id]), options, ...extra });
}

describe('canonical v4 extraction and paid evidence reuse', () => {
    it('retains a quiet mistake and keeps an uncorroborated alternative pending', async () => {
        const engine = quietEngine(); const output = await run(engine);
        expect(output.moments).toHaveLength(1); const candidate = output.moments[0]; const manifest = candidate.solution.manifest;
        expect(parsePracticeMomentRevision(manifest).decision.selection).toBe('INCLUDED');
        expect(manifest.rootAnswerIndex.preferredMoveUci).toBe('e2e3');
        expect(lookupAnswer(manifest.rootAnswerIndex, 'd2d3', manifest.assessments, []).quality).toBe('UNKNOWN');
        expect(lookupAnswer(manifest.rootAnswerIndex, 'g1f3', manifest.assessments, []).quality).toBe('UNKNOWN');
        expect(manifest.rootAnswerIndex.readiness).toBe('PARTIAL'); expect(manifest.continuation.mode).toBe('SINGLE_DECISION');
        expect(candidate.solution.manifest.semanticHash).toBe(solutionSemanticsHash(candidate.solution));
        expect(validateTrainingMomentCandidates(JSON.parse(JSON.stringify(output.moments))).ok).toBe(true);
    });
    it('projects confirmation into the moment without any fresh root/continuation search', async () => {
        const engine = quietEngine(); await run(engine, game('1. e4 *'), { strategy: 'FIRST_PUZZLE' });
        const confirmation = engine.requests.filter(request => request.purpose !== 'GAME_SCAN');
        expect(confirmation.map(request => request.purpose)).toEqual(['MISSING_REFERENCE', 'VERIFY_REFERENCE', 'MISSING_MOVE']);
        expect(confirmation[0].nodes).toBe(200_000);
        expect(engine.requests.filter(request => request.purpose === 'GAME_SCAN')).toHaveLength(2);
    });
    it('corroborates an original absent from MultiPV with two singleton searches', async () => {
        const engine = quietEngine();
        const output = await run(engine, game('1. e4 *'), { strategy: 'FIRST_PUZZLE', options: { ...options, multiPv: 2 } });
        expect(output.moments).toHaveLength(1);
        expect(engine.requests.filter(request => request.purpose !== 'GAME_SCAN').map(request => [request.purpose, request.rootMoves])).toEqual([
            ['MISSING_REFERENCE', undefined], ['VERIFY_REFERENCE', ['e2e3']], ['MISSING_MOVE', ['e2e4']], ['MISSING_MOVE', ['e2e4']],
        ]);
    });
    it('requires the original and reference at the confirmation budget despite stable scan snapshots', async () => {
        const engine = quietEngine(); const output = await run(engine);
        const manifest = output.moments[0].solution.manifest;
        expect(manifest.executionProfileSnapshot.minimumConfirmationNodes).toBe(200_000);
        expect(engine.requests.some(request => request.purpose === 'MISSING_REFERENCE' && request.nodes === 200_000)).toBe(true);
        expect(manifest.assessments.find(a => a.id === manifest.decision.originalAssessmentId)?.qualitySupport).toBe('SUPPORTED');
    });
    it('refreshes an outranked reference and corroborates the original against it', async () => {
        const engine = quietEngine().set(START, [{ move: 'e2e3', cp: 0 }, { move: 'd2d3', cp: -5 }, { move: 'e2e4', cp: -200 }]);
        engine.onRequest = request => {
            if (request.purpose === 'MISSING_MOVE') engine.set(START, [{ move: 'e2e3', cp: 0 }, { move: 'd2d3', cp: -5 }, { move: 'e2e4', cp: 60 }]);
            if (request.purpose === 'REFERENCE_DRIFT') engine.set(START, [{ move: 'e2e3', cp: 280 }, { move: 'd2d3', cp: 270 }, { move: 'e2e4', cp: 60 }]);
        };
        const output = await run(engine, game('1. e4 *'), { strategy: 'FIRST_PUZZLE', options: { ...options, multiPv: 2 } });
        expect(output.moments).toHaveLength(1);
        expect(engine.requests.filter(request => request.purpose !== 'GAME_SCAN').map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000], ['MISSING_MOVE', 200_000], ['REFERENCE_DRIFT', 400_000], ['VERIFY_REFERENCE', 400_000], ['MISSING_MOVE', 400_000],
        ]);
        expect(parsePracticeMomentRevision(output.moments[0].solution.manifest).decision.selection).toBe('INCLUDED');
    });
    it('cannot borrow the original singleton budget to qualify a shallow reference after resume', async () => {
        const engine = quietEngine();
        const scanned = await run(engine, game('1. e4 *'), { shouldYield: () => true });
        expect(scanned.checkpoint?.pendingScan).toBeDefined();
        const checkpoint = parseExtractionCheckpoint(JSON.parse(JSON.stringify(scanned.checkpoint)))!;
        const pool = PositionAnalysisPool.hydrate(checkpoint.analysisPool);
        await pool.wrap(engine).evalPosition({ fen: START, previousFens: [], rootMoves: ['e2e4'], nodes: 800_000, purpose: 'MISSING_MOVE', reuse: 'FRESH_REQUIRED' });
        checkpoint.analysisPool = pool.serialize();
        const beforeResume = engine.requests.length;
        const output = await run(engine, game('1. e4 *'), { checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(checkpoint))) });
        expect(output.moments).toHaveLength(1);
        expect(engine.requests.slice(beforeResume).filter(request => request.purpose !== 'OPTIONAL_COVERAGE').map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000],
        ]);
        expect(parsePracticeMomentRevision(output.moments[0].solution.manifest).decision.status).toBe('CONFIRMED_MISTAKE');
    });
    it('missing complete snapshots never become supported verdicts', async () => {
        const engine = quietEngine(); engine.snapshotDepths = [];
        const output = await run(engine);
        expect(output.moments).toEqual([]);
        expect(output.analysis?.get('fixture')?.trainingExtraction.decisions[0].status).toBe('UNRESOLVED');
    });
    it('rejects a shallow scan candidate whose original is good on confirmation', async () => {
        const engine = quietEngine(); engine.onRequest = request => {
            if (request.purpose === 'MISSING_REFERENCE') engine.set(START, [{ move: 'e2e3', cp: 100 }, { move: 'e2e4', cp: 90 }, { move: 'd2d3', cp: 80 }]);
        };
        const output = await run(engine); expect(output.moments).toEqual([]);
        expect(output.analysis?.get('fixture')?.trainingExtraction.decisions[0].reason).toBe('ORIGINAL_MOVE_QUALITY_CONFIRMED');
    });
    it('transports a canonical disproof for an existing decision below the new scan threshold', async () => {
        const engine = quietEngine().set(START, [{ move: 'e2e4', cp: 100 }, { move: 'e2e3', cp: 95 }, { move: 'd2d3', cp: 90 }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -100 }]);
        const output = await run(engine, game('1. e4 *'), { reassessDecisionPliesByGameId: { fixture: [0] } });
        expect(output.moments).toHaveLength(1);
        expect(parsePracticeMomentRevision(output.moments[0].solution.manifest).decision)
            .toMatchObject({ status: 'NOT_A_MISTAKE', selection: 'OMITTED' });
        expect(validateTrainingMomentCandidates(output.moments).ok).toBe(true);
        expect(output.manifests[0].decisionOutcomes).toContainEqual(expect.objectContaining({ decisionPly: 0, status: 'NOT_A_MISTAKE' }));
        expect(engine.requests.some(request => request.purpose === 'MISSING_REFERENCE' && request.nodes === 200_000)).toBe(true);
        expect(engine.requests.some(request => request.purpose === 'OPTIONAL_COVERAGE')).toBe(false);
        const ordinary = await run(engine);
        expect(ordinary.moments).toEqual([]);
    });
    it('freezes reassessment targeting across checkpoint resume and ignores it for homepage selection', async () => {
        const engine = quietEngine().set(START, [{ move: 'e2e4', cp: 100 }, { move: 'e2e3', cp: 95 }, { move: 'd2d3', cp: 90 }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -100 }]);
        const partial = await run(engine, game('1. e4 *'), { reassessDecisionPliesByGameId: new Map([['fixture', [0]]]), shouldYield: () => true });
        const checkpoint = parseExtractionCheckpoint(JSON.parse(JSON.stringify(partial.checkpoint)));
        expect(checkpoint.reassessDecisionPlies).toEqual([0]);
        const resumed = await run(engine, game('1. e4 *'), { checkpoint, reassessDecisionPliesByGameId: { fixture: [] } });
        expect(resumed.moments[0]?.solution.manifest.decision.status).toBe('NOT_A_MISTAKE');
        const first = await run(engine, game('1. e4 *'), { strategy: 'FIRST_PUZZLE', reassessDecisionPliesByGameId: { fixture: [0] } });
        expect(first.moments).toEqual([]);
    });
    it('a saturated cp swing does not need a lesson label and does not enter the feed alone', async () => {
        const engine = quietEngine().set(START, [{ move: 'e2e3', cp: 1000 }, { move: 'd2d3', cp: 900 }, { move: 'e2e4', cp: 500 }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -500 }]);
        const output = await run(engine); expect(output.moments).toEqual([]);
        expect(output.analysis?.get('fixture')?.trainingExtraction.decisions[0].reason).toBe('NO_MEANINGFUL_SELECTION_SIGNAL');
    });
    it('keeps a cp-close but matched-WDL-bad original below standard through validation', async () => {
        const engine = quietEngine().set(START, [{ move: 'e2e3', cp: 100, wdl: { win: 900, draw: 100, loss: 0 } }, { move: 'd2d3', cp: 95, wdl: { win: 900, draw: 100, loss: 0 } }, { move: 'e2e4', cp: 90, wdl: { win: 300, draw: 100, loss: 600 } }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -90, wdl: { win: 600, draw: 100, loss: 300 } }]);
        const output = await run(engine); expect(output.moments).toHaveLength(1);
        const manifest = parsePracticeMomentRevision(output.moments[0].solution.manifest);
        expect(manifest.frames[0].model).toBe('MATCHED_WDL');
        expect(manifest.assessments.find(a => a.moveUci === 'e2e4')).toMatchObject({ quality: 'BELOW_STANDARD', metrics: { lossCp: 10, lossExpectedScore: 0.6 } });
    });
    it('stops original-only deepening at the hard cap when the boundary remains unresolved', async () => {
        const engine = quietEngine(); engine.transformIteration = (request, lines) => request.purpose === 'GAME_SCAN' ? lines : lines.map(line => line.move === 'e2e4' ? { ...line, cp: 10 } : line);
        const output = await run(engine); expect(output.moments).toEqual([]);
        expect(engine.requests.filter(r => r.purpose === 'MISSING_REFERENCE')).toHaveLength(1);
        expect(engine.requests.filter(r => r.purpose === 'MISSING_MOVE').map(r => r.nodes)).toEqual([200_000, 400_000, 800_000]);
        expect(output.analysis?.get('fixture')?.trainingExtraction.decisions[0].confirmation?.termination).toBe('MAX_BUDGET_UNSTABLE');
    });
    it('retains one assessment per move and refuses malformed duplicate snapshot slots', async () => {
        const engine = quietEngine(); engine.transformIteration = (request, lines) => request.method === 'multi' ? [lines[0], lines[0], ...lines.slice(2)] : lines;
        const output = await run(engine); expect(output.moments).toEqual([]);
    });
});

describe('source replay, selected side, cancellation and checkpointing', () => {
    it.each(['white', 'black'] as const)('FIRST scans once and confirms only the imported %s decisions', async side => {
        const source = game('1. e4 e5 2. Nf3 Nc6 *', 'side', side); const engine = new ScriptedExtractionEngine();
        const board = new Chess(); board.loadPgn(source.pgn);
        for (const move of board.history({ verbose: true })) { const turn = new Chess(move.before).turn(); const legal = new Chess(move.before).moves({ verbose: true }); engine.set(move.before, [{ move: legal[0].lan, cp: turn === (side === 'white' ? 'w' : 'b') ? 200 : 0 }]); }
        engine.onRequest = request => { if (request.method === 'multi') throw Error('Unavailable confirmation'); };
        const progress = vi.fn(); const output = await run(engine, source, { strategy: 'FIRST_PUZZLE', onProgress: progress });
        expect(progress.mock.calls.filter(([item]) => item.phase === 'confirming').map(([item]) => item.ply)).toEqual(side === 'white' ? [0, 2] : [1, 3]);
        expect(engine.requests.filter(request => request.purpose === 'GAME_SCAN')).toHaveLength(5);
        expect(output.manifests).toMatchObject([{ scope: 'TARGETED_DECISION', scanComplete: true, extractionComplete: false, complete: false }]);
    });
    it('scans exactly N+1 history contexts for a quiet N-ply source', async () => {
        const engine = new ScriptedExtractionEngine(); const source = game('1. e4 e5 2. Nf3 Nc6 *');
        const output = await run(engine, source); const scans = engine.requests.filter(r => r.purpose === 'GAME_SCAN');
        expect(scans).toHaveLength(5); expect(scans.map(r => r.previousFens?.length)).toEqual([0, 1, 2, 3, 4]);
        expect(output.moments).toEqual([]); expect(output.manifests).toMatchObject([{ complete: true }]);
        expect(output.engineWork).toMatchObject({ physicalSearches: 5, requestedNodes: 500_000, reportedNodes: 500_000,
            byReason: { GAME_SCAN: { physicalSearches: 5, requestedNodes: 500_000 } } });
        expect(output.analysis?.get(source.id)?.trainingExtraction.engineWork).toEqual(output.engineWork);
    });
    it('reports Black setup positions with source-relative ply zero', async () => {
        const fen = '7k/8/5Q2/8/6K1/8/8/8 b - - 0 42'; const progress = vi.fn();
        const source = game(`[SetUp "1"]\n[FEN "${fen}"]\n\n42... Kg8 *`, 'black-setup', 'black');
        await run(new ScriptedExtractionEngine(), source, { strategy: 'FIRST_PUZZLE', onProgress: progress });
        expect(progress.mock.calls[0][0]).toMatchObject({ ply: 0, plyCount: 1, fen, positionHistory: [], userSide: 'black' });
    });
    it('cancels before dispatching confirmation after the scan', async () => {
        const engine = quietEngine(); const controller = new AbortController();
        const output = run(engine, game('1. e4 *'), { strategy: 'FIRST_PUZZLE', signal: controller.signal, onProgress: item => { if (item.phase === 'confirming') controller.abort(); } });
        await expect(output).rejects.toThrow('Analysis aborted');
        expect(engine.requests.filter(r => r.method === 'multi')).toHaveLength(0);
    });
    it('rejects FIRST_PUZZLE combined with resumable extraction', async () => {
        await expect(run(quietEngine(), game('1. e4 *'), { strategy: 'FIRST_PUZZLE', shouldYield: () => true })).rejects.toThrow('FIRST_PUZZLE does not support full-game checkpoints');
    });
    it('keeps adjacent scan evidence across repeated checkpoint round trips', async () => {
        const engine = new ScriptedExtractionEngine(); const source = game('1. e4 e5 2. Nf3 Nc6 *');
        let output = await run(engine, source, { shouldYield: () => true });
        for (let i = 0; output.checkpoint && i < 20; i++) output = await run(engine, source, { shouldYield: () => true, checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(output.checkpoint))) });
        expect(output.checkpoint).toBeUndefined(); expect(output.analysis?.get(source.id)?.moves).toHaveLength(4);
        expect(engine.requests.filter(r => r.purpose === 'GAME_SCAN')).toHaveLength(5);
    });
    it('resumes completed confirmation without repeating scan or reference searches', async () => {
        const engine = quietEngine(); let confirmed = false; engine.onRequest = r => { if (r.purpose === 'MISSING_REFERENCE') confirmed = true; };
        const first = await run(engine, game('1. e4 *'), { shouldYield: () => confirmed });
        expect(first.checkpoint?.pendingConfirmation).toBeDefined(); const searches = engine.requests.length;
        const resumed = await run(engine, game('1. e4 *'), { checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(first.checkpoint))) });
        expect(resumed.moments).toHaveLength(1);
        expect(engine.requests.slice(searches).every(request => request.purpose === 'OPTIONAL_COVERAGE')).toBe(true);
        expect(engine.requests.slice(searches).length).toBeLessThanOrEqual(1);
    });
    it('emits an explicit incomplete manifest when training side cannot be resolved', async () => {
        const output = await run(new ScriptedExtractionEngine(), game('1. e4 *', 'unknown', 'unknown'));
        expect(output.moments).toEqual([]); expect(output.manifests[0].complete).toBe(false);
    });
});

describe('rules and tactical representation', () => {
    it('recognizes en passant as a capture when tagging themes', () => {
        const fen = 'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
        expect(tacticalMoveFacts(new Chess(fen), 'e5d6')).toMatchObject({ isCapture: true });
    });
    it('preserves an underpromotion as the canonical best move', async () => {
        const fen = '7k/P7/8/8/8/6p1/8/7K w - - 0 1';
        const source = game(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. a8=Q+ *`);
        const engine = new ScriptedExtractionEngine().set(fen, [{ move: 'a7a8n', cp: 200 }, { move: 'a7a8q', cp: -200 }]).set(afterFixtureMove(fen, 'a7a8q'), [{ move: 'h8g7', cp: 200 }]);
        const output = await run(engine, source); expect(output.moments).toHaveLength(1);
        expect(output.moments[0].solution.manifest.rootAnswerIndex.preferredMoveUci).toBe('a7a8n');
    });
    it('keeps tactical sacrifices without requiring a recognized lesson', async () => {
        const fen = '3rk3/8/8/8/8/8/8/3QK3 w - - 0 1';
        const engine = new ScriptedExtractionEngine().set(fen, [{ move: 'd1d8', cp: 200, pv: ['d1d8', 'e8d8'] }, { move: 'd1c2', cp: -200 }]).set(afterFixtureMove(fen, 'd1c2'), [{ move: 'd8d1', cp: 200 }]);
        const output = await run(engine, game(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Qc2 *`));
        expect(output.moments).toHaveLength(1); expect(output.moments[0].solution.manifest.rootAnswerIndex.preferredMoveUci).toBe('d1d8');
    });
    it('does not promote a third repetition claim to a mandatory terminal draw', () => {
        const board = new Chess(); const history: string[] = [];
        for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) { history.push(board.fen()); board.move(san); }
        expect(claimableDraw(board.fen(), history)).toBe('THREEFOLD_REPETITION'); expect(ruleTerminalEvaluation(board.fen(), history)).toBeNull();
    });
    it('keeps a complete rule-proven mate opportunity versus stalemate as exact evidence', async () => {
        const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
        const engine = new ScriptedExtractionEngine().set(fen, [{ move: 'f7f8', mate: 1 }]);
        const output = await run(engine, game(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Qe6 *`));
        expect(output.moments).toHaveLength(1); const manifest = parsePracticeMomentRevision(output.moments[0].solution.manifest);
        expect(manifest.frames[0].model).toBe('EXACT_OUTCOME'); expect(manifest.decision.selectionSignal).toBe('EXACT_OUTCOME_LOSS');
        expect(engine.requests.filter(r => r.purpose !== 'GAME_SCAN')).toEqual([]);
    });
    it('rejects source continuation after an automatic draw without searching the ended game', async () => {
        const fen = '7k/8/8/8/8/8/R7/K7 w - - 150 1'; const engine = new ScriptedExtractionEngine();
        const output = await run(engine, game(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Ra3 *`));
        expect(output.moments).toEqual([]); expect(engine.requests).toHaveLength(0); expect(output.manifests[0].complete).toBe(false);
    });
});
