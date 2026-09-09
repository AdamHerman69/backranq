import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSourcePgn, validateAnalyzedMovesAgainstPgn } from '@/lib/chess/pgn';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { ScriptedExtractionEngine } from '../helpers/extraction-engine';
import { mockPrismaModule } from '../helpers/route-mocks';

async function produce(pgn: string, side: 'white' | 'black') {
    mockPrismaModule();
    const jobs = await import('@/lib/services/analysisJobs');
    const canonical = jobs.serverAnalysisConfigFromPreferences({ analysisQuality: 'T2' }).config;
    const restored = jobs.serverAnalysisConfigFromSnapshot({ snapshot: canonical.snapshot, hash: canonical.hash });
    expect(restored).not.toBeNull();
    const engine = new ScriptedExtractionEngine();
    const output = await extractTrainingMomentsFromGames({
        games: [{ id: 'chesscom:fixture', provider: 'chesscom', pgn,
            playedAt: '2026-08-01T00:00:00.000Z', timeClass: 'blitz',
            white: { name: side === 'white' ? 'adam' : 'opponent' },
            black: { name: side === 'black' ? 'adam' : 'opponent' },
            provenance: { username: 'adam', userSide: side } }],
        selectedGameIds: new Set(['chesscom:fixture']), engine,
        canonicalSourceGameIdByGameId: { 'chesscom:fixture': 'game-1' },
        analysisConfigHash: canonical.hash, options: restored!.options,
    });
    const run = { id: 'run-1', userId: 'user-1', gameId: 'game-1',
        inputPgnHash: hashSourcePgn(pgn), configHash: canonical.hash,
        configSnapshot: canonical.snapshot, startedAt: new Date() };
    const tx = {
        analysisRun: { findFirst: vi.fn().mockResolvedValue(run),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: vi.fn().mockResolvedValue({ ...run, status: 'SUCCEEDED' }) },
        analyzedGame: { findFirst: vi.fn().mockResolvedValue({ id: 'game-1', pgn,
            provider: 'CHESSCOM', playedAt: new Date('2026-08-01T00:00:00.000Z') }),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'game-1' }) },
        trainingMoment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const runs = await import('@/lib/services/analysisRuns');
    const args = { tx: tx as unknown as Parameters<typeof runs.completeAnalysisRunWithGameAnalysisInTransaction>[0]['tx'],
        runId: run.id, analysis: output.analysis!.get('chesscom:fixture')!,
        trainingMoments: output.moments, extractionManifest: output.manifests[0] };
    return { tx, args, runs, engine };
}

describe('T2 producer through canonical analysis persistence', () => {
    beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
    it.each([
        ['black', '1. e4 e5 2. Nf3 *', 3, 1],
        ['white', '1. e4 e5 *', 2, 0],
    ] as const)('completes sparse %s display output against all source plies', async (side, pgn, sourcePlies, displayedPly) => {
        const { tx, args, runs, engine } = await produce(pgn, side);
        expect(args.analysis.moves.map(move => move.ply)).toEqual([displayedPly]);
        expect(args.extractionManifest).toMatchObject({ expectedPlies: sourcePlies, scannedPlies: sourcePlies, complete: true });
        expect(args.trainingMoments).toEqual([]);
        await expect(runs.completeAnalysisRunWithGameAnalysisInTransaction(args)).resolves.toMatchObject({ run: { status: 'SUCCEEDED' } });
        expect(tx.analysisRun.findFirst).toHaveBeenCalledTimes(2); // Includes real training persistence provenance binding.
        expect(tx.analyzedGame.updateMany).toHaveBeenCalledTimes(1);
        expect(engine.requests).toHaveLength(2); // Saving cannot add opponent searches.
    });
    it('rejects a manifest that substitutes sparse display count for full source count', async () => {
        const { tx, args, runs } = await produce('1. e4 e5 2. Nf3 *', 'black');
        args.extractionManifest = { ...args.extractionManifest, expectedPlies: 1, scannedPlies: 1, decisionOutcomes: [] };
        await expect(runs.completeAnalysisRunWithGameAnalysisInTransaction(args)).rejects.toThrow(/complete extraction manifest/i);
        expect(tx.analyzedGame.updateMany).not.toHaveBeenCalled();
    });
    it.each(['duplicate', 'out-of-order', 'out-of-range', 'wrong-move', 'fractional'] as const)(
        'rejects %s display data before persistence', async (mutation) => {
            const { tx, args, runs } = await produce('1. e4 e5 2. Nf3 *', 'black');
            const row = args.analysis.moves[0];
            if (mutation === 'duplicate') args.analysis.moves.push({ ...row });
            if (mutation === 'out-of-order') args.analysis.moves.push({ ...row, ply: 0, uci: 'e2e4' });
            if (mutation === 'out-of-range') row.ply = 3;
            if (mutation === 'wrong-move') row.uci = 'd7d5';
            if (mutation === 'fractional') row.ply = 1.5;
            await expect(runs.completeAnalysisRunWithGameAnalysisInTransaction(args)).rejects.toThrow(/analysis does not match source PGN/i);
            expect(tx.analyzedGame.updateMany).not.toHaveBeenCalled();
        });
    it('validates promotions and preserves invalid-PGN rejection', () => {
        const pgn = '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=Q+ *';
        expect(validateAnalyzedMovesAgainstPgn(pgn, [{ ply: 0, uci: 'a7a8q' }])).toEqual({ sourcePlies: 1 });
        expect(validateAnalyzedMovesAgainstPgn(pgn, [{ ply: 0, uci: 'a7a8' }])).toBeNull();
        expect(validateAnalyzedMovesAgainstPgn('1. e5 *', [])).toBeNull();
    });
});
