import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import {
    fetchChessComGames,
    fetchChessComGamesBatch,
} from '@/lib/providers/chesscom';
import {
    fetchLichessGames,
    fetchLichessGamesBatch,
} from '@/lib/providers/lichess';
import { lookupProviderProfile } from '@/lib/providers/profileLookup';
import type { NormalizedGame, GameSource } from '@/lib/types/game';

const RUN_LIVE_PROVIDER_TESTS =
    process.env.BACKRANQ_RUN_LIVE_PROVIDER_TESTS === 'true';
const CHESSCOM_USERNAME =
    process.env.BACKRANQ_LIVE_CHESSCOM_USERNAME ?? 'adam1a4';
const LICHESS_USERNAME =
    process.env.BACKRANQ_LIVE_LICHESS_USERNAME ?? 'aldicigg';
const USE_PRODUCTION_ANALYSIS_BUDGET =
    process.env.BACKRANQ_LIVE_PRODUCTION_ANALYSIS === 'true';
const ANALYSIS_NODES = USE_PRODUCTION_ANALYSIS_BUDGET ? 100_000 : 5_000;
const CONFIRM_NODES = USE_PRODUCTION_ANALYSIS_BUDGET ? 200_000 : 10_000;
const ANALYSIS_TIMEOUT_MS = USE_PRODUCTION_ANALYSIS_BUDGET
    ? 90_000
    : 30_000;
const CURRENT_PROVIDER_INTERVAL = {
    since: '2020-01-01T00:00:00.000Z',
    until: '2030-01-01T00:00:00.000Z',
};

function expectValidProviderGames(args: {
    games: NormalizedGame[];
    provider: GameSource;
    username: string;
    maximum?: number;
}) {
    expect(args.games.length).toBeGreaterThan(0);
    if (args.maximum != null) {
        expect(args.games.length).toBeLessThanOrEqual(args.maximum);
    }

    const username = args.username.toLocaleLowerCase('en-US');
    const ids = new Set<string>();
    let previousPlayedAt = Number.POSITIVE_INFINITY;

    for (const game of args.games) {
        expect(game.provider).toBe(args.provider);
        expect(game.id.startsWith(`${args.provider}:`)).toBe(true);
        expect(ids.has(game.id)).toBe(false);
        ids.add(game.id);

        const playedAt = new Date(game.playedAt).getTime();
        expect(Number.isFinite(playedAt)).toBe(true);
        expect(playedAt).toBeLessThanOrEqual(previousPlayedAt);
        previousPlayedAt = playedAt;

        const players = [game.white.name, game.black.name].map((name) =>
            name.toLocaleLowerCase('en-US')
        );
        expect(players).toContain(username);

        const chess = new Chess();
        expect(() => chess.loadPgn(game.pgn, { strict: false })).not.toThrow();
        expect(chess.history().length).toBeGreaterThan(0);
    }
}

function replayLength(game: NormalizedGame) {
    const chess = new Chess();
    chess.loadPgn(game.pgn, { strict: false });
    return chess.history().length;
}

function representativeGame(games: NormalizedGame[]) {
    const ranked = games
        .map((game) => ({ game, plies: replayLength(game) }))
        .filter(({ plies }) => plies >= 16 && plies <= 48)
        .sort((a, b) => a.plies - b.plies);
    const selected = ranked[0]?.game;
    expect(selected, 'expected a bounded representative game').toBeDefined();
    return selected as NormalizedGame;
}

describe.skipIf(!RUN_LIVE_PROVIDER_TESTS)(
    'live provider account compatibility',
    () => {
        it(
            'validates both public provider profiles through the production lookup',
            async () => {
                await expect(
                    lookupProviderProfile({
                        provider: 'chesscom',
                        username: CHESSCOM_USERNAME,
                    })
                ).resolves.toEqual({ state: 'found' });
                await expect(
                    lookupProviderProfile({
                        provider: 'lichess',
                        username: LICHESS_USERNAME,
                    })
                ).resolves.toEqual({ state: 'found' });
            },
            30_000
        );

        it(
            'normalizes recent Chess.com games into valid, newest-first PGNs',
            async () => {
                const result = await fetchChessComGames({
                    username: CHESSCOM_USERNAME,
                    filters: { max: 25 },
                    signal: AbortSignal.timeout(30_000),
                });
                expectValidProviderGames({
                    games: result.games,
                    provider: 'chesscom',
                    username: CHESSCOM_USERNAME,
                    maximum: 25,
                });
            },
            40_000
        );

        it(
            'normalizes recent Lichess games into valid, newest-first PGNs',
            async () => {
                const result = await fetchLichessGames({
                    username: LICHESS_USERNAME,
                    filters: { max: 25 },
                    signal: AbortSignal.timeout(30_000),
                });
                expectValidProviderGames({
                    games: result.games,
                    provider: 'lichess',
                    username: LICHESS_USERNAME,
                    maximum: 25,
                });
            },
            40_000
        );

        it(
            'honors the bounded first-sync cap for both provider pagination models',
            async () => {
                const [chesscom, lichess] = await Promise.all([
                    fetchChessComGamesBatch({
                        username: CHESSCOM_USERNAME,
                        ...CURRENT_PROVIDER_INTERVAL,
                        firstSyncMaxGames: 40,
                        signal: AbortSignal.timeout(30_000),
                    }),
                    fetchLichessGamesBatch({
                        username: LICHESS_USERNAME,
                        ...CURRENT_PROVIDER_INTERVAL,
                        firstSyncMaxGames: 40,
                        signal: AbortSignal.timeout(30_000),
                    }),
                ]);

                expect(chesscom.complete).toBe(true);
                expect(chesscom.nextUntil).toBeNull();
                expectValidProviderGames({
                    games: chesscom.games,
                    provider: 'chesscom',
                    username: CHESSCOM_USERNAME,
                });

                expect(lichess.complete).toBe(true);
                expect(lichess.nextUntil).toBeNull();
                expectValidProviderGames({
                    games: lichess.games,
                    provider: 'lichess',
                    username: LICHESS_USERNAME,
                });
            },
            60_000
        );

        it(
            'replays and analyzes one real game from each provider with Stockfish',
            async () => {
                const [chesscomResult, lichessResult] = await Promise.all([
                    fetchChessComGames({
                        username: CHESSCOM_USERNAME,
                        filters: { max: 50 },
                        signal: AbortSignal.timeout(30_000),
                    }),
                    fetchLichessGames({
                        username: LICHESS_USERNAME,
                        filters: { max: 50 },
                        signal: AbortSignal.timeout(30_000),
                    }),
                ]);
                const games = [
                    representativeGame(chesscomResult.games),
                    representativeGame(lichessResult.games),
                ];
                const engine = new ServerStockfishClient({
                    defaultNodes: ANALYSIS_NODES,
                    defaultTimeoutMs: ANALYSIS_TIMEOUT_MS,
                });

                try {
                    const result = await extractTrainingMomentsFromGames({
                        games,
                        selectedGameIds: new Set(
                            games.map((game) => game.id)
                        ),
                        engine,
                        options: {
                            nodesPerPosition: ANALYSIS_NODES,
                            confirmNodes: CONFIRM_NODES,
                            engineTimeoutMs: ANALYSIS_TIMEOUT_MS,
                            multiPv: 3,
                            maxAcceptedMoves: 3,
                            verifyContinuations: true,
                            verificationNodesPerPosition: ANALYSIS_NODES,
                            verificationMaxPositions: 12,
                            verificationMaxPlies: 8,
                            returnAnalysis: true,
                        },
                    });

                    expect(result.manifests).toHaveLength(2);
                    for (const manifest of result.manifests) {
                        expect(manifest.complete).toBe(true);
                        expect(manifest.termination).toBe('COMPLETED');
                        expect(manifest.scannedPlies).toBe(
                            manifest.expectedPlies
                        );
                    }
                    for (const game of games) {
                        const analysis = result.analysis?.get(game.id);
                        expect(analysis).toBeDefined();
                        expect(analysis?.moves.length).toBe(
                            replayLength(game)
                        );
                    }
                    for (const moment of result.moments) {
                        expect(
                            games.some(
                                (game) =>
                                    game.id === moment.sourceGameId
                            )
                        ).toBe(true);
                        expect(moment.solution.bestMoveUci).toMatch(
                            /^[a-h][1-8][a-h][1-8][qrbn]?$/
                        );
                        expect(
                            moment.solution.acceptedMovesUci.length
                        ).toBeGreaterThan(0);
                    }
                    console.info(
                        JSON.stringify({
                            liveAnalysis: games.map((game) => ({
                                provider: game.provider,
                                plies: replayLength(game),
                                positions: result.moments.filter(
                                    (moment) =>
                                        moment.sourceGameId === game.id
                                ).length,
                                nodesPerPosition: ANALYSIS_NODES,
                            })),
                        })
                    );
                } finally {
                    engine.terminate();
                }
            },
            5 * 60_000
        );
    }
);
