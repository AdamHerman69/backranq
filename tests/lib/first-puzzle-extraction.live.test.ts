import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { expect, it, vi } from 'vitest';
import { CORROBORATED_SELECTION_POLICY_ID, T2_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import { extractTrainingMomentsFromGames, isLandingReadyTrainingMoment } from '@/lib/analysis/extractTrainingMoments';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type { NormalizedGame } from '@/lib/types/game';

it.skipIf(process.env.RUN_FIRST_PUZZLE_SMOKE !== '1')(
    'real Stockfish scans once and finds the next puzzle after two unavailable confirmations',
    async () => {
        const corpus = JSON.parse(readFileSync('tests/fixtures/training-v2/real-games.corpus.v1.json', 'utf8'));
        const source = corpus.games.find((game: NormalizedGame) => game.id === 'chesscom:0f8e42f0-8fda-11f1-b9f6-9dd41a01000f') as NormalizedGame;
        const board = new Chess(); board.loadPgn(source.pgn);
        const plyCount = board.history().length;
        const engine = new ServerStockfishClient();
        const scan = vi.spyOn(engine, 'evalPosition');
        const analyze = engine.analyzeMultiPv.bind(engine);
        const rejected = new Set<string>();
        vi.spyOn(engine, 'analyzeMultiPv').mockImplementation(async request => {
            // Confirmation may need either a missing reference or a reference
            // refresh after scan evidence drifts. Exercise unavailable full-root
            // confirmation independently of that planner reason.
            if (request.purpose !== 'GAME_SCAN' && !request.rootMoves?.length
                && (rejected.has(request.fen) || rejected.size < 2)) {
                rejected.add(request.fen);
                throw new Error('Injected unavailable confirmation to exercise candidate fallback');
            }
            return analyze(request);
        });
        try {
            const result = await extractTrainingMomentsFromGames({
                games: [source], selectedGameIds: new Set([source.id]), engine,
                strategy: 'FIRST_PUZZLE',
                options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, returnAnalysis: false, nodesPerPosition: 12_000, confirmNodes: 180_000,
                    maxConfirmationNodes: 500_000 },
            });
            expect(rejected.size).toBe(2);
            expect(result.moments).toHaveLength(1);
            expect(result.moments[0]!.solution.manifest.decision.status).toBe('CONFIRMED_MISTAKE');
            expect(rejected.has(result.moments[0]!.fen)).toBe(false);
            const scans = scan.mock.calls.filter(([request]) => request.purpose === 'GAME_SCAN');
            expect(scans).toHaveLength(plyCount + 1);
            expect(new Set(scans.map(([request]) => JSON.stringify([request.fen, request.previousFens]))).size).toBe(plyCount + 1);
            expect(result.manifests).toMatchObject([{ scanComplete: true, extractionComplete: false, complete: false }]);
        } finally { engine.terminate(); }
    }, 90_000,
);

it.skipIf(process.env.RUN_FIRST_PUZZLE_SMOKE !== '1')(
    'real production T2 shares its bounded scan with FIRST_PUZZLE and returns valid selection evidence',
    async () => {
        const corpus = JSON.parse(readFileSync('tests/fixtures/training-v2/real-games.corpus.v1.json', 'utf8'));
        const source = corpus.games.find((game: NormalizedGame) => game.id === 'chesscom:0f8e42f0-8fda-11f1-b9f6-9dd41a01000f') as NormalizedGame;
        const board = new Chess(); board.loadPgn(source.pgn);
        const moves = board.history({ verbose: true });
        const side = source.provenance!.userSide === 'white' ? 'w' : 'b';
        const needed = new Set(moves.flatMap((move, ply) => move.color === side ? [ply, ply + 1] : []));
        const engine = new ServerStockfishClient();
        const analyze = vi.spyOn(engine, 'analyzeMultiPv');
        const single = vi.spyOn(engine, 'evalPosition');
        try {
            const result = await extractTrainingMomentsFromGames({ games: [source], selectedGameIds: new Set([source.id]), engine,
                strategy: 'FIRST_PUZZLE', options: { selectionPolicyId: T2_SELECTION_POLICY_ID } });
            expect(result.moments.some(isLandingReadyTrainingMoment)).toBe(true);
            expect(validateTrainingMomentCandidates(result.moments).ok).toBe(true);
            expect(result.moments.every(moment => moment.solution.manifest.selection.policyId === T2_SELECTION_POLICY_ID)).toBe(true);
            expect(result.manifests).toMatchObject([{ scanComplete: true, extractionComplete: false, complete: false }]);
            expect(single).not.toHaveBeenCalled();
            const requests = analyze.mock.calls.map(([request]) => request);
            const scans = requests.filter(request => request.purpose === 'T2_SCAN');
            expect(scans.length).toBeGreaterThan(0);
            expect(scans.every(request => request.nodes === 100_000 && request.multiPv === 1 && !request.rootMoves)).toBe(true);
            expect(new Set(scans.map(request => JSON.stringify([request.fen, request.previousFens]))).size).toBe(scans.length);
            expect(requests.filter(request => request.purpose !== 'T2_SCAN').every(request => request.nodes === 200_000
                && (request.purpose === 'T2_TARGETED_ROOT' && request.multiPv === 3 && !request.rootMoves
                    || request.purpose === 'T2_TARGETED_ORIGINAL' && request.multiPv === 1 && request.rootMoves?.length === 1))).toBe(true);
            expect(requests.reduce((sum, request) => sum + (request.nodes ?? 0), 0)).toBeLessThanOrEqual(needed.size * 100_000 + 2_000_000);
        } finally { engine.terminate(); }
    }, 90_000,
);
