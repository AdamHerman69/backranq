import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { expect, it, vi } from 'vitest';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
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
            if (request.purpose === 'MISTAKE_REFERENCE' && (rejected.has(request.fen) || rejected.size < 2)) {
                rejected.add(request.fen);
                throw new Error('Injected unavailable confirmation to exercise candidate fallback');
            }
            return analyze(request);
        });
        try {
            const result = await extractTrainingMomentsFromGames({
                games: [source], selectedGameIds: new Set([source.id]), engine,
                strategy: 'FIRST_PUZZLE',
                options: { returnAnalysis: false, nodesPerPosition: 12_000, confirmNodes: 180_000,
                    maxConfirmationNodes: 500_000, verificationNodesPerPosition: 80_000 },
            });
            expect(rejected.size).toBe(2);
            expect(result.moments).toHaveLength(1);
            expect(result.moments[0]!.solution.decision.status).toBe('CONFIRMED_MISTAKE');
            expect(rejected.has(result.moments[0]!.fen)).toBe(false);
            const scans = scan.mock.calls.filter(([request]) => request.purpose === 'GAME_SCAN');
            expect(scans).toHaveLength(plyCount + 1);
            expect(new Set(scans.map(([request]) => JSON.stringify([request.fen, request.previousFens]))).size).toBe(plyCount + 1);
            expect(result.manifests).toMatchObject([{ scanComplete: true, extractionComplete: false, complete: false }]);
        } finally { engine.terminate(); }
    }, 90_000,
);
