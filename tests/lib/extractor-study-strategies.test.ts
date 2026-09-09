import { CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { Chess } from 'chess.js';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { describe, expect, it } from 'vitest';
import { assertBaselineComplete, pointDecision, pointDecisionV2, replayStudyGame, runStrategy, validStudyLine } from '../../scripts/extractor-study/strategies';
import type { Profile, StudyGame } from '../../scripts/extractor-study/types';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';
import { parseConfig } from '../../scripts/extractor-study/config';
import blitzConfig from '../../experiments/extractor-economics/blitz.json';

const START = new Chess().fen();
const profile: Profile = { id: 'E0', mode: 'POINT', scanNodes: 100_000, rootMultiPv: 5,
    additional: 'NONE', rounds: [], postScanGameNodes: 8_000_000, postScanCandidateNodes: 600_000 };
function source(pgn = '1. e4 *', side: 'white' | 'black' = 'white'): StudyGame {
    return { account: 'adam', rating: 1400, bucket: 1, split: 'development', sourceHash: 'test', game: {
        id: 'fixture', provider: 'chesscom', playedAt: '2026-08-01T00:00:00.000Z', timeClass: 'blitz', pgn,
        white: { name: side === 'white' ? 'adam' : 'opponent' }, black: { name: side === 'black' ? 'adam' : 'opponent' },
        provenance: { username: 'adam', userSide: side } } };
}
function engine(original = -200) {
    return new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 100 }, { move: 'e2e4', cp: original }])
        .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -original }]);
}

describe('research extractor admission strategies (mock engines only)', () => {
    it('admits an obvious scan loss without a single confirmation or certified product moment', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source(), profile, engine: mock });
        expect(mock.requests).toHaveLength(2);
        expect(mock.requests.every(r => r.purpose === 'STUDY_SCAN')).toBe(true);
        expect(result.decisions[0]).toMatchObject({ admitted: true, estimate: 'BELOW_STANDARD', lossCp: 300, comparisonBasis: 'PARENT_CHILD_SCAN' });
        expect(result.productMoments).toEqual([]);
    });
    it('scans each required canonical position once and records every user decision', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source('1. e4 e5 2. Nf3 *'), profile, engine: mock });
        expect(result.decisions.map(d => d.ply)).toEqual([0, 2]);
        expect(new Set(mock.requests.map(r => JSON.stringify([r.fen, r.previousFens]))).size).toBe(mock.requests.length);
        expect(mock.requests.at(-1)?.previousFens).toHaveLength(3);
    });
    it('reuses the original move from a paid full-root query', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source(), profile: { ...profile, additional: 'PAIR_ONCE', rounds: [100_000] }, engine: mock });
        expect(mock.requests.map(r => r.purpose)).toEqual(['STUDY_SCAN', 'STUDY_SCAN', 'STUDY_ROOT']);
        expect(result.decisions[0]).toMatchObject({ admitted: true, comparisonBasis: 'SAME_ROOT' });
    });
    it('reserves candidate pair cost before dispatch and never overspends a cap', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source(), profile: { ...profile, additional: 'PAIR_ONCE', rounds: [200_000], postScanCandidateNodes: 300_000 }, engine: mock });
        expect(mock.requests).toHaveLength(2);
        expect(result.decisions[0].reason).toContain('POLICY_BUDGET_EXHAUSTED');
    });
    it('adaptive mode accepts an obvious scan loss without extra queries', async () => {
        const mock = engine();
        await runStrategy({ game: source(), profile: { ...profile, additional: 'ADAPTIVE', rounds: [100_000, 200_000] }, engine: mock });
        expect(mock.requests).toHaveLength(2);
    });
    it('WINDOW compares only the last two complete iterations and rejects their disagreement', async () => {
        const mock = engine();
        mock.transformIteration = (request, lines, iteration) => request.fen === START && iteration === 1
            ? lines.map(line => ({ ...line, cp: -150 })) : lines;
        const result = await runStrategy({ game: source(), profile: { ...profile, mode: 'WINDOW' }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', reason: 'WINDOW_UNRESOLVED' });
    });
    it('WINDOW accepts two complete agreeing depths without any node floor', async () => {
        const mock = engine(); mock.snapshotDepths = [1, 2];
        const result = await runStrategy({ game: source(), profile: { ...profile, scanNodes: 10, mode: 'WINDOW' }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, reason: 'WINDOW_MISTAKE' });
    });
    it('rejects invalid provenance and malformed PGN before any search', async () => {
        const mock = engine(); const wrong = source(); wrong.game.provenance!.userSide = 'black';
        await expect(runStrategy({ game: wrong, profile, engine: mock })).rejects.toThrow('SOURCE_SIDE_INVALID');
        await expect(runStrategy({ game: source('1. e9 *'), profile, engine: mock })).rejects.toThrow();
        expect(mock.requests).toHaveLength(0);
    });
    it('keeps black perspective and custom FEN history', async () => {
        const game = source('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 *', 'black');
        const replay = replayStudyGame(game);
        const mock = new ScriptedExtractionEngine().set(replay.positions[0], [{ move: 'c7c5', cp: 100 }])
            .set(replay.positions[1], [{ move: 'g1f3', cp: 200 }]);
        const result = await runStrategy({ game, profile, engine: mock });
        expect(result.decisions[0]).toMatchObject({ originalMoveUci: 'e7e5', admitted: true, lossCp: 300 });
        expect(mock.requests[1].previousFens).toEqual([replay.positions[0]]);
    });
    it('uses mandatory terminal result without asking engine for that position', async () => {
        const mock = new ScriptedExtractionEngine();
        await runStrategy({ game: source('1. f3 e5 2. g4 Qh4# 0-1', 'black'), profile, engine: mock });
        expect(mock.requests).toHaveLength(3);
        expect(mock.requests.some(r => new Chess(r.fen).isCheckmate())).toBe(false);
    });
    it('does not accept illegal PV or bound lines', () => {
        expect(validStudyLine(START, { multipv: 1, score: { type: 'cp', value: 1 }, pvUci: ['e2e4', 'e2e3'] })).toBe(false);
        expect(validStudyLine(START, { multipv: 1, score: { type: 'cp', value: 1 }, pvUci: ['e2e4'], bound: 'LOWER' } as never)).toBe(false);
    });
    it('rejects truncated, foreign, or missing extraction records instead of counting them as completed', async () => {
        const game = source();
        const result = await extractTrainingMomentsFromGames({ games: [game.game],
            selectedGameIds: new Set([game.game.id]), engine: engine(), options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, returnAnalysis: true } });
        expect(() => assertBaselineComplete(result, game)).not.toThrow();
        const mutations: Array<(value: typeof result) => void> = [
            value => { value.manifests = []; },
            value => { value.manifests[0].complete = false; value.manifests[0].termination = 'SOURCE_REPLAY_STOPPED'; },
            value => { value.manifests[0].sourcePgnHash = 'foreign'; },
            value => { value.manifests[0].decisionOutcomes = []; },
            value => { value.analysis = undefined; },
            value => { value.analysis!.get(game.game.id)!.trainingExtraction!.decisions = []; },
            value => { value.analysis!.get(game.game.id)!.trainingExtraction!.trainingSide = 'BLACK'; },
        ];
        for (const mutate of mutations) {
            const broken = structuredClone(result); mutate(broken);
            expect(() => assertBaselineComplete(broken, game)).toThrow(/BASELINE_INCOMPLETE/);
        }
    });
    it('executes the real baseline and validates then compacts its production moments', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source(), profile: { ...profile, mode: 'SINGLE', additional: 'CURRENT' }, engine: mock });
        expect(result.errors).toEqual([]);
        expect(result.decisions[0]).toMatchObject({ admitted: true, comparisonBasis: 'PRODUCT_POLICY', estimate: 'BELOW_STANDARD' });
        expect(result.productMoments).toHaveLength(1);
        expect(result.productMoments[0]).toHaveProperty('semanticHash');
        expect(result.productMoments[0]).not.toHaveProperty('solution');
    });
});

describe('targeted verification keeps scan admission independent of support gates', () => {
    const targeted: Profile = { ...profile, id: 'T0', additional: 'TARGETED', rounds: [200_000], rootMultiPv: 3,
        postScanCandidateNodes: 400_000, postScanGameNodes: 2_000_000 };
    const bestWdl = { win: 700, draw: 200, loss: 100 };
    const lowerWdl = { win: 300, draw: 400, loss: 300 };
    function lowCpEngine() {
        return new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 100, wdl: bestWdl }, { move: 'e2e4', cp: 50, wdl: lowerWdl }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -50, wdl: { win: lowerWdl.loss, draw: lowerWdl.draw, loss: lowerWdl.win } }]);
    }
    it('validates TARGETED as exactly one round and POINT only, keeping old configs valid', () => {
        expect(parseConfig(blitzConfig).profiles).toHaveLength(blitzConfig.profiles.length);
        expect(parseConfig({ ...blitzConfig, profiles: [targeted] }).profiles[0].additional).toBe('TARGETED');
        for (const invalid of [{ ...targeted, rounds: [] }, { ...targeted, rounds: [100_000, 200_000] }, { ...targeted, mode: 'WINDOW' }]) {
            expect(() => parseConfig({ ...blitzConfig, profiles: [invalid] })).toThrow('TARGETED requires');
        }
    });
    it('checks a WDL-only small-cp admission once and reuses original found in MultiPV3', async () => {
        const mock = lowCpEngine();
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(mock.requests.map(r => r.purpose)).toEqual(['STUDY_SCAN', 'STUDY_SCAN', 'STUDY_TARGETED_ROOT']);
        expect(mock.requests.at(-1)).toMatchObject({ nodes: 200_000, multiPv: 3 });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: {
            triggers: ['WDL_LOW_CP'], outcome: 'VERIFIED', requestedNodes: 200_000, initial: { admitted: true, lossCp: 50 } } });
        expect(result.decisions[0].targetedVerification!.searchIds).toHaveLength(1);
    });
    it('can correct the initial WDL signal to GOOD after the one targeted query', async () => {
        const mock = lowCpEngine();
        mock.onRequest = request => {
            if (request.purpose === 'STUDY_TARGETED_ROOT') mock.set(START, [{ move: 'd2d4', cp: 100, wdl: bestWdl }, { move: 'e2e4', cp: 70, wdl: bestWdl }]);
        };
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'GOOD', targetedVerification: { outcome: 'VERIFIED', initial: { admitted: true } } });
        expect(mock.requests).toHaveLength(3);
    });
    it('does no extra work for a clear cp loss even without older snapshots', async () => {
        const mock = engine(); mock.snapshotDepths = [12];
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(mock.requests).toHaveLength(2);
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { triggers: [], outcome: 'NOT_TRIGGERED', requestedNodes: 0 } });
    });
    it('triggers on the latest two scan acceptance estimates disagreeing', async () => {
        const mock = engine();
        mock.transformIteration = (request, lines, index) => request.purpose === 'STUDY_SCAN' && request.fen === START && index === 1
            ? lines.map(line => ({ ...line, cp: -150 })) : lines;
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { triggers: ['SCAN_ACCEPTANCE_DISAGREEMENT'], outcome: 'VERIFIED' } });
        expect(result.decisions[0].targetedVerification!.scanSnapshotIds).toHaveLength(4);
        expect(mock.requests).toHaveLength(3);
    });
    it('can trigger even when the latest scan is good but the previous scan admitted', async () => {
        const mock = engine(50);
        mock.transformIteration = (request, lines, index) => request.purpose === 'STUDY_SCAN' && request.fen === START && index === 1
            ? lines.map(line => ({ ...line, cp: 250 })) : lines;
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, targetedVerification: { triggers: ['SCAN_ACCEPTANCE_DISAGREEMENT'], outcome: 'VERIFIED' } });
        expect(mock.requests).toHaveLength(3);
    });
    it('does not mistake invalid scan evidence for semantic disagreement or admit it', async () => {
        const mock = engine();
        const analyze = mock.analyzeMultiPv.bind(mock);
        mock.analyzeMultiPv = async request => ({ ...await analyze(request), alternativesComplete: false });
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', targetedVerification: { triggers: [], outcome: 'NOT_TRIGGERED' } });
        expect(mock.requests).toHaveLength(2);
    });
    it('spends at most a root plus original and leaves remaining semantic conflict unresolved', async () => {
        const mock = engine(200);
        mock.set(START, [{ move: 'd2d4', cp: 100 }, { move: 'c2c4', cp: 90 }, { move: 'g1f3', cp: 80 }, { move: 'e2e4', cp: 200 }]);
        const result = await runStrategy({ game: source(), profile: targeted, engine: mock });
        expect(mock.requests.map(r => r.purpose)).toEqual(['STUDY_SCAN', 'STUDY_SCAN', 'STUDY_TARGETED_ROOT', 'STUDY_TARGETED_ORIGINAL']);
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', targetedVerification: { triggers: ['SEMANTIC_CONFLICT'], outcome: 'UNRESOLVED', requestedNodes: 400_000 } });
    });
    it('respects zero game allowance while keeping a noncontradictory scan estimate pending', async () => {
        const mock = lowCpEngine();
        const result = await runStrategy({ game: source(), profile: { ...targeted, postScanGameNodes: 0 }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { outcome: 'SKIPPED_BUDGET', requestedNodes: 0 } });
        expect(mock.requests).toHaveLength(2);
    });
    it('uses a fitting root request even when the worst-case pair does not fit the candidate cap', async () => {
        const mock = lowCpEngine();
        const result = await runStrategy({ game: source(), profile: { ...targeted, postScanCandidateNodes: 200_000 }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { outcome: 'VERIFIED', requestedNodes: 200_000 } });
        expect(mock.requests).toHaveLength(3);
    });
    it('does not dispatch a missing original beyond the remaining candidate allowance', async () => {
        const mock = lowCpEngine();
        mock.set(START, [{ move: 'd2d4', cp: 100, wdl: bestWdl }, { move: 'c2c4', cp: 90, wdl: bestWdl }, { move: 'g1f3', cp: 80, wdl: bestWdl }, { move: 'e2e4', cp: 50, wdl: lowerWdl }]);
        const result = await runStrategy({ game: source(), profile: { ...targeted, postScanCandidateNodes: 200_000 }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, comparisonBasis: 'PARENT_CHILD_SCAN', targetedVerification: { outcome: 'SKIPPED_BUDGET', requestedNodes: 200_000 } });
        expect(mock.requests).toHaveLength(3);
    });
});

describe('point semantics preserve quality versus selection', () => {
    const compare = (best: number, original: number) => pointDecision({ ply: 0, originalMoveUci: 'e2e4', preferredMoveUci: 'd2d4',
        referenceScore: { type: 'cp', value: best }, originalScore: { type: 'cp', value: original }, comparisonBasis: 'SAME_ROOT', evidenceIds: ['test'] });
    it('rejects +0.2 to -1.3 but accepts +3.2 to +2.5', () => {
        expect(compare(20, -130)).toMatchObject({ admitted: true, estimate: 'BELOW_STANDARD' });
        expect(compare(320, 250)).toMatchObject({ admitted: false, estimate: 'GOOD' });
    });
    it('does not call saturated CP loss a meaningful practice moment', () => {
        expect(compare(1000, 400)).toMatchObject({ estimate: 'BELOW_STANDARD', admitted: false, reason: 'NO_MEANINGFUL_SELECTION_SIGNAL' });
    });
    it('does not clip contradictory negative loss into a valid good grade', () => {
        expect(compare(0, 200)).toMatchObject({ estimate: 'UNKNOWN', reason: 'REFERENCE_CONTRADICTION', lossCp: -200 });
    });
    it('does not mix one-sided WDL with a CP-only conclusion', () => {
        const result = pointDecision({ ply: 0, originalMoveUci: 'e2e4', preferredMoveUci: 'd2d4',
            referenceScore: { type: 'cp', value: 0 }, originalScore: { type: 'cp', value: -300 },
            referenceWdl: { win: 200, draw: 600, loss: 200 }, comparisonBasis: 'SAME_ROOT', evidenceIds: [] });
        expect(result).toMatchObject({ admitted: false, estimate: 'UNKNOWN', reason: 'WDL_MISSING_OR_INVALID' });
    });
    it('uses matched WDL to allow a meaningful loss in an initially winning position', () => {
        const result = pointDecision({ ply: 0, originalMoveUci: 'e2e4', preferredMoveUci: 'd2d4',
            referenceScore: { type: 'cp', value: 400 }, originalScore: { type: 'cp', value: -200 },
            referenceWdl: { win: 900, draw: 100, loss: 0 }, originalWdl: { win: 100, draw: 100, loss: 800 },
            comparisonBasis: 'SAME_ROOT', evidenceIds: [] });
        expect(result).toMatchObject({ admitted: true, estimate: 'BELOW_STANDARD' });
        expect(result.lossExpectedScore).toBeCloseTo(0.8);
    });
    it('does not treat equal mate winners as blunders because of distance', () => {
        const input = { ply: 0, originalMoveUci: 'e2e4', preferredMoveUci: 'd2d4',
            referenceScore: { type: 'mate' as const, value: 2 }, originalScore: { type: 'mate' as const, value: 8 },
            comparisonBasis: 'SAME_ROOT' as const, evidenceIds: [] };
        expect(pointDecision(input)).toMatchObject({ estimate: 'GOOD', admitted: false });
        expect(pointDecision({ ...input, originalScore: { type: 'cp', value: 600 } })).toMatchObject({ estimate: 'UNKNOWN', admitted: false, reason: 'MIXED_SCORE_KINDS' });
        expect(pointDecision({ ...input, originalScore: { type: 'mate', value: -4 } })).toMatchObject({ estimate: 'BELOW_STANDARD', admitted: true, reason: 'ENGINE_MATE_WINNER_LOSS' });
    });
});

describe('T1 outcome projection and selective verification preserve prior profiles', () => {
    const t1: Profile = { ...profile, id: 'T1', additional: 'TARGETED_V2', rounds: [200_000], rootMultiPv: 3,
        postScanGameNodes: 2_000_000, postScanCandidateNodes: 400_000 };
    const mixed = { ply: 0, originalMoveUci: 'e2e4', preferredMoveUci: 'd2d4',
        referenceScore: { type: 'cp' as const, value: 475 }, originalScore: { type: 'mate' as const, value: -2 },
        referenceWdl: { win: 1000, draw: 0, loss: 0 }, originalWdl: { win: 0, draw: 0, loss: 1000 },
        comparisonBasis: 'SAME_ROOT' as const, evidenceIds: ['fixture-root', 'fixture-original'] };
    function mixedEngine() {
        return new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 475, wdl: mixed.referenceWdl },
            { move: 'e2e4', mate: -2, wdl: mixed.originalWdl }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', mate: 2, wdl: mixed.referenceWdl }]);
    }
    it('accepts clear mixed outcome loss without converting mate into CP or changing old POINT', () => {
        expect(pointDecisionV2(mixed)).toMatchObject({ admitted: true, estimate: 'BELOW_STANDARD',
            lossCp: null, lossExpectedScore: 1, reason: 'MIXED_WDL_OUTCOME_LOSS' });
        expect(pointDecision(mixed)).toMatchObject({ admitted: false, estimate: 'UNKNOWN', reason: 'MIXED_SCORE_KINDS' });
    });
    it('normalizes arbitrary positive WDL totals and accepts a small mixed outcome difference', () => {
        const result = pointDecisionV2({ ...mixed, referenceScore: { type: 'mate', value: 4 },
            originalScore: { type: 'cp', value: 300 }, referenceWdl: { win: 2000, draw: 0, loss: 0 },
            originalWdl: { win: 1800, draw: 200, loss: 0 } });
        expect(result).toMatchObject({ admitted: false, estimate: 'GOOD', lossCp: null, reason: 'MIXED_WDL_WITHIN_TOLERANCE' });
        expect(result.lossExpectedScore).toBeCloseTo(0.05);
    });
    it('keeps reversed mixed ordering unresolved instead of treating a better original as a loss', () => {
        const result = pointDecisionV2({ ...mixed, referenceWdl: { win: 600, draw: 400, loss: 0 },
            originalScore: { type: 'mate', value: 2 }, originalWdl: { win: 1000, draw: 0, loss: 0 } });
        expect(result).toMatchObject({ admitted: false, estimate: 'UNKNOWN', reason: 'MIXED_WDL_REFERENCE_CONTRADICTION' });
        expect(result.lossExpectedScore).toBeCloseTo(-0.2);
    });
    it('rejects mate zero, malformed distance, and WDL contradicting the mate winner', () => {
        for (const value of [0, -1.5]) expect(pointDecisionV2({ ...mixed, originalScore: { type: 'mate', value } }))
            .toMatchObject({ estimate: 'UNKNOWN', admitted: false, reason: 'MIXED_MATE_REQUIRES_NONZERO_DISTANCE' });
        expect(pointDecisionV2({ ...mixed, originalWdl: { win: 1000, draw: 0, loss: 0 } }))
            .toMatchObject({ estimate: 'UNKNOWN', admitted: false, reason: 'MIXED_MATE_WDL_CONTRADICTION' });
    });
    it('does not invent mixed evidence from missing, negative, zero-total, or overflow WDL', () => {
        for (const originalWdl of [undefined, { win: -1, draw: 0, loss: 1001 }, { win: 0, draw: 0, loss: 0 },
            { win: Number.MAX_VALUE, draw: Number.MAX_VALUE, loss: Number.MAX_VALUE }]) {
            expect(pointDecisionV2({ ...mixed, originalWdl })).toMatchObject({ estimate: 'UNKNOWN', admitted: false, reason: 'MIXED_WDL_MISSING_OR_INVALID' });
        }
    });
    it('admits the stable +475 to mate loss directly while old T0 still runs its original unresolved check', async () => {
        const mock = mixedEngine();
        const result = await runStrategy({ game: source(), profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, lossCp: null, lossExpectedScore: 1,
            targetedVerification: { triggers: [], outcome: 'NOT_TRIGGERED', requestedNodes: 0 } });
        expect(mock.requests).toHaveLength(2);
        const oldMock = mixedEngine();
        const old = await runStrategy({ game: source(), profile: { ...t1, additional: 'TARGETED' }, engine: oldMock });
        expect(old.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', targetedVerification: { triggers: ['SEMANTIC_CONFLICT'], outcome: 'UNRESOLVED' } });
        expect(oldMock.requests).toHaveLength(3);
    });
    it('does not spend on negative/reference differences already omitted by the scan', async () => {
        const mock = engine(200);
        const result = await runStrategy({ game: source(), profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', reason: 'REFERENCE_CONTRADICTION',
            targetedVerification: { triggers: [], outcome: 'NOT_TRIGGERED', requestedNodes: 0 } });
        expect(mock.requests).toHaveLength(2);
    });
    it('verifies WDL-only 90cp losses within the CP tolerance that old T0 skips', async () => {
        const make = () => new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 10, wdl: { win: 3, draw: 996, loss: 1 } },
            { move: 'e2e4', cp: -80, wdl: { win: 0, draw: 788, loss: 212 } }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: 80, wdl: { win: 212, draw: 788, loss: 0 } }]);
        const mock = make(); const result = await runStrategy({ game: source(), profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ targetedVerification: { triggers: ['WDL_ONLY'], outcome: 'VERIFIED', requestedNodes: 200_000 } });
        expect(mock.requests).toHaveLength(3);
        const oldMock = make(); const old = await runStrategy({ game: source(), profile: { ...t1, additional: 'TARGETED' }, engine: oldMock });
        expect(old.decisions[0]).toMatchObject({ targetedVerification: { triggers: [], outcome: 'NOT_TRIGGERED' } });
        expect(oldMock.requests).toHaveLength(2);
    });
    it('uses the winning-position CP tolerance rather than a hard 100cp ceiling', async () => {
        const mock = new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 300, wdl: { win: 1000, draw: 0, loss: 0 } },
            { move: 'e2e4', cp: 150, wdl: { win: 600, draw: 400, loss: 0 } }])
            .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -150, wdl: { win: 0, draw: 400, loss: 600 } }]);
        const result = await runStrategy({ game: source(), profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ targetedVerification: { triggers: ['WDL_ONLY'], requestedNodes: 200_000 } });
    });
    it('normalizes mixed child mate evidence to the black training perspective', async () => {
        const game = source('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 *', 'black');
        const replay = replayStudyGame(game);
        const mock = new ScriptedExtractionEngine().set(replay.positions[0], [{ move: 'c7c5', cp: 475, wdl: mixed.referenceWdl }])
            .set(replay.positions[1], [{ move: 'g1f3', mate: 2, wdl: mixed.referenceWdl }]);
        const result = await runStrategy({ game, profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ originalMoveUci: 'e7e5', admitted: true, lossCp: null, lossExpectedScore: 1,
            originalScore: { type: 'mate', value: -2 }, originalWdl: { win: 0, draw: 0, loss: 1000 } });
        expect(mock.requests).toHaveLength(2);
    });
    it('leaves invalid mixed evidence unresolved without a futile extra search', async () => {
        const mock = mixedEngine();
        mock.set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', mate: 0, wdl: mixed.referenceWdl }]);
        const result = await runStrategy({ game: source(), profile: t1, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: false, estimate: 'UNKNOWN', targetedVerification: { triggers: [], requestedNodes: 0 } });
        expect(mock.requests).toHaveLength(2);
    });
    it('retains snapshot-disagreement verification and the single-round game cap', async () => {
        const mock = engine();
        mock.transformIteration = (request, lines, index) => request.purpose === 'STUDY_SCAN' && request.fen === START && index === 1
            ? lines.map(line => ({ ...line, cp: -150 })) : lines;
        const result = await runStrategy({ game: source(), profile: { ...t1, postScanGameNodes: 200_000 }, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { triggers: ['SCAN_ACCEPTANCE_DISAGREEMENT'], outcome: 'VERIFIED', requestedNodes: 200_000 } });
        expect(mock.requests).toHaveLength(3);
    });
    it('validates T1 as exactly one round and POINT only without changing original configurations', () => {
        expect(parseConfig(blitzConfig).profiles).toHaveLength(blitzConfig.profiles.length);
        expect(parseConfig({ ...blitzConfig, profiles: [t1] }).profiles[0].additional).toBe('TARGETED_V2');
        for (const invalid of [{ ...t1, rounds: [] }, { ...t1, rounds: [100_000, 200_000] }, { ...t1, mode: 'WINDOW' }]) {
            expect(() => parseConfig({ ...blitzConfig, profiles: [invalid] })).toThrow('TARGETED_V2 requires');
        }
    });
});

describe('T2 changes only verification order under the existing budget', () => {
    const t2: Profile = { ...profile, id: 'T2', additional: 'TARGETED_PRIORITY', rounds: [200_000], rootMultiPv: 3,
        postScanGameNodes: 200_000, postScanCandidateNodes: 400_000 };
    function fixture(losses: number[]) {
        const game = source(losses.length === 2 ? '1. e4 e5 2. Nf3 *' : '1. e4 e5 2. Nf3 Nc6 3. Bb5 *');
        const replay = replayStudyGame(game);
        const mock = new ScriptedExtractionEngine();
        const wdl = (e: number) => ({ win: Math.round(e * 1000), draw: 0, loss: 1000 - Math.round(e * 1000) });
        for (const [index, loss] of losses.entries()) {
            const ply = index * 2; const move = replay.moves[ply];
            const original = `${move.from}${move.to}${move.promotion ?? ''}`;
            const preferred = new Chess(move.before).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`).find(m => m !== original)!;
            mock.set(move.before, [{ move: preferred, cp: 100, wdl: wdl(0.8) }, { move: original, cp: 50, wdl: wdl(0.8 - loss) }]);
            const reply = new Chess(move.after).moves({ verbose: true })[0];
            mock.set(move.after, [{ move: `${reply.from}${reply.to}${reply.promotion ?? ''}`, cp: -50, wdl: wdl(1 - (0.8 - loss)) }]);
        }
        return { game, replay, mock, wdl };
    }
    it('spends the scarce allowance on the admitted loss nearest .1 and preserves result ply order', async () => {
        const { game, mock } = fixture([0.3, 0.11]);
        const result = await runStrategy({ game, profile: t2, engine: mock });
        expect(mock.requests.filter(r => r.purpose === 'STUDY_TARGETED_ROOT').map(r => r.previousFens!.length)).toEqual([2]);
        expect(result.decisions.map(d => d.ply)).toEqual([0, 2]);
        expect(result.decisions[0].targetedVerification).toMatchObject({ outcome: 'SKIPPED_BUDGET', requestedNodes: 0 });
        expect(result.decisions[1].targetedVerification).toMatchObject({ outcome: 'VERIFIED', requestedNodes: 200_000 });
        const old = fixture([0.3, 0.11]);
        await runStrategy({ game: old.game, profile: { ...t2, additional: 'TARGETED_V2' }, engine: old.mock });
        expect(old.mock.requests.filter(r => r.purpose === 'STUDY_TARGETED_ROOT').map(r => r.previousFens!.length)).toEqual([0]);
    });
    it('checks an admitted moment before an even closer nonadmitted snapshot-disagreement candidate', async () => {
        const { game, replay, mock, wdl } = fixture([0.3, 0.095]);
        mock.transformIteration = (request, lines, index) => request.purpose === 'STUDY_SCAN' && request.fen === replay.positions[3] && index === 1
            ? lines.map(line => ({ ...line, wdl: wdl(1 - (0.8 - 0.115)) })) : lines;
        const result = await runStrategy({ game, profile: t2, engine: mock });
        expect(mock.requests.filter(r => r.purpose === 'STUDY_TARGETED_ROOT').map(r => r.previousFens!.length)).toEqual([0]);
        expect(result.decisions[0].targetedVerification).toMatchObject({ outcome: 'VERIFIED' });
        expect(result.decisions[1]).toMatchObject({ admitted: false, targetedVerification: { triggers: ['SCAN_ACCEPTANCE_DISAGREEMENT'], outcome: 'SKIPPED_BUDGET' } });
    });
    it('orders nonadmitted snapshot candidates by the same proximity after admissions', async () => {
        const { game, replay, mock, wdl } = fixture([0.05, 0.09]);
        mock.transformIteration = (request, lines, index) => request.purpose === 'STUDY_SCAN'
            && [replay.positions[1], replay.positions[3]].includes(request.fen) && index === 1
            ? lines.map(line => ({ ...line, wdl: wdl(1 - (0.8 - 0.15)) })) : lines;
        const result = await runStrategy({ game, profile: t2, engine: mock });
        expect(mock.requests.filter(r => r.purpose === 'STUDY_TARGETED_ROOT').map(r => r.previousFens!.length)).toEqual([2]);
        expect(result.decisions[0].targetedVerification).toMatchObject({ outcome: 'SKIPPED_BUDGET' });
        expect(result.decisions[1].targetedVerification).toMatchObject({ outcome: 'VERIFIED' });
    });
    it('breaks equal proximity by ply and never spends the leftover allowance below a whole query', async () => {
        const { game, mock } = fixture([0.11, 0.11, 0.2]);
        const result = await runStrategy({ game, profile: { ...t2, postScanGameNodes: 300_000 }, engine: mock });
        expect(mock.requests.filter(r => r.purpose === 'STUDY_TARGETED_ROOT').map(r => r.previousFens!.length)).toEqual([0]);
        expect(result.decisions.reduce((n, d) => n + (d.targetedVerification?.requestedNodes ?? 0), 0)).toBe(200_000);
        expect(result.decisions.slice(1).every(d => d.targetedVerification?.outcome === 'SKIPPED_BUDGET')).toBe(true);
    });
    it('does not turn an untriggered admitted cp mistake into verification work', async () => {
        const mock = engine();
        const result = await runStrategy({ game: source(), profile: t2, engine: mock });
        expect(result.decisions[0]).toMatchObject({ admitted: true, targetedVerification: { outcome: 'NOT_TRIGGERED', requestedNodes: 0 } });
        expect(mock.requests).toHaveLength(2);
    });
    it('requires POINT and one round for T2 without changing original config validity', () => {
        expect(parseConfig(blitzConfig).profiles).toHaveLength(blitzConfig.profiles.length);
        expect(parseConfig({ ...blitzConfig, profiles: [t2] }).profiles[0].additional).toBe('TARGETED_PRIORITY');
        for (const invalid of [{ ...t2, rounds: [] }, { ...t2, rounds: [100_000, 200_000] }, { ...t2, mode: 'WINDOW' }]) {
            expect(() => parseConfig({ ...blitzConfig, profiles: [invalid] })).toThrow('TARGETED_PRIORITY requires');
        }
    });
});
