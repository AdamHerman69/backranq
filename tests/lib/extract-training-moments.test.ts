import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import {
    extractTrainingMomentsFromGames,
    tacticalMoveFacts,
    type TrainingMomentExtractionOptions,
} from '@/lib/analysis/extractTrainingMoments';
import { parseExtractionCheckpoint } from '@/lib/analysis/extractionCheckpoint';
import { negateScore, reverseWdl } from '@/lib/analysis/evaluation';
import type {
    AnalysisLimit,
    EvalResult,
    MultiPvResult,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import type {
    TablebaseEvidence,
    TablebaseProvider,
} from '@/lib/analysis/tablebase';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import type { NormalizedGame } from '@/lib/types/game';

type EvalFactory = (
    limit: AnalysisLimit & { fen: string },
) => EvalResult | Promise<EvalResult>;
type MultiFactory = (
    limit: AnalysisLimit & { fen: string; multiPv?: number },
) => MultiPvResult | Promise<MultiPvResult>;

class FixtureEngine implements StockfishEngine {
    constructor(
        private readonly evalFactory: EvalFactory,
        private readonly multiFactory: MultiFactory,
    ) {}

    async evalPosition(opts: AnalysisLimit & { fen: string }) {
        if (opts.rootMoves?.length === 1) {
            const root = opts.rootMoves[0]!;
            const board = new Chess(opts.fen);
            board.move({
                from: root.slice(0, 2),
                to: root.slice(2, 4),
                promotion: root.slice(4) || undefined,
            });
            const after = await this.evalFactory({
                ...opts,
                fen: board.fen(),
                rootMoves: undefined,
            });
            return {
                ...after,
                fen: opts.fen,
                bestMoveUci: root,
                pvUci: [root, ...after.pvUci],
                score: negateScore(after.score),
                wdl: reverseWdl(after.wdl),
            };
        }
        return this.evalFactory(opts);
    }

    analyzeMultiPv(opts: AnalysisLimit & { fen: string; multiPv?: number }) {
        return Promise.resolve(this.multiFactory(opts));
    }
}

function game(args: {
    id: string;
    pgn: string;
    white?: string;
    black?: string;
    sourceUsername?: string;
    userSide?: 'white' | 'black' | 'unknown';
}): NormalizedGame {
    const white = args.white ?? 'adam';
    const black = args.black ?? 'opponent';
    const userSide =
        args.userSide ??
        (white.toLowerCase() === 'adam'
            ? 'white'
            : black.toLowerCase() === 'adam'
              ? 'black'
              : 'unknown');
    return {
        id: args.id,
        provider: 'lichess',
        playedAt: '2026-01-01T00:00:00.000Z',
        timeClass: 'rapid',
        white: { name: white },
        black: { name: black },
        pgn: args.pgn,
        provenance: {
            username: args.sourceUsername ?? 'adam',
            userSide,
        },
    };
}

function result(args: {
    fen: string;
    bestMove: string;
    pv: string[];
    cp?: number;
    mate?: number;
}): EvalResult {
    return {
        fen: args.fen,
        bestMoveUci: args.bestMove,
        pvUci: args.pv,
        score:
            args.mate == null
                ? { type: 'cp', value: args.cp ?? 0 }
                : { type: 'mate', value: args.mate },
    };
}

function multi(
    fen: string,
    lines: Array<{
        move: string;
        pv?: string[];
        cp?: number;
        mate?: number;
    }>,
): MultiPvResult {
    return {
        fen,
        bestMoveUci: lines[0]?.move ?? '',
        alternativesComplete: true,
        lines: lines.map((line, index) => ({
            multipv: index + 1,
            pvUci: line.pv ?? [line.move],
            score:
                line.mate == null
                    ? { type: 'cp', value: line.cp ?? 0 }
                    : { type: 'mate', value: line.mate },
        })),
    };
}

function afterUci(fen: string, moveUci: string): string {
    const chess = new Chess(fen);
    chess.move({
        from: moveUci.slice(0, 2),
        to: moveUci.slice(2, 4),
        promotion: moveUci.slice(4, 5) || undefined,
    });
    return chess.fen();
}

const baseOptions: TrainingMomentExtractionOptions = {
    nodesPerPosition: 100,
    confirmNodes: null,
    verifyContinuations: false,
};

describe('canonical decision evidence extraction', () => {
    it.each(['white', 'black'] as const)(
        'FIRST_PUZZLE scans once then confirms only the imported %s decisions',
        async (userSide) => {
            const source = game({ id: 'first-puzzle-side', pgn: '1. e4 e5 2. Nf3 Nc6 *',
                white: userSide === 'white' ? 'adam' : 'opponent',
                black: userSide === 'black' ? 'adam' : 'opponent', userSide });
            const confirm = vi.fn(() => { throw new Error('Inconclusive confirmation'); });
            const engine = new FixtureEngine(({ fen }) => {
                const chess = new Chess(fen);
                const move = chess.moves({ verbose: true })[0]!;
                const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
                return result({ fen, bestMove: uci, pv: [uci], cp: chess.turn() === 'w' ? 200 : 0 });
            }, confirm);
            const evalSpy = vi.spyOn(engine, 'evalPosition');
            const progress: Array<Parameters<NonNullable<Parameters<typeof extractTrainingMomentsFromGames>[0]['onProgress']>>[0]> = [];
            const output = await extractTrainingMomentsFromGames({
                games: [source], selectedGameIds: new Set([source.id]), engine,
                strategy: 'FIRST_PUZZLE', onProgress: item => progress.push(item), options: baseOptions,
            });
            expect(progress.filter(item => item.phase === 'confirming').map(item => item.ply))
                .toEqual(userSide === 'white' ? [0, 2] : [1, 3]);
            expect(progress.map(item => item.phase)).toEqual(['scanning', 'scanning', 'scanning', 'scanning', 'confirming', 'confirming']);
            expect(evalSpy.mock.calls.filter(([request]) => request.purpose === 'GAME_SCAN')).toHaveLength(5);
            expect(confirm).toHaveBeenCalledTimes(2);
            expect(new Set(progress.map(item => item.runId)).size).toBe(1);
            expect(progress.every(item => item.userSide === userSide)).toBe(true);
            expect(progress[1]!.previousFen).toBe(progress[0]!.fen);
            expect(progress[1]!.positionHistory).toEqual([progress[0]!.fen]);
            expect(output.moments).toEqual([]);
            expect(output.manifests).toMatchObject([{ scope: 'TARGETED_DECISION', scanComplete: true,
                extractionComplete: false, complete: false, scannedPlies: 4, expectedPlies: 4 }]);
            expect(output.checkpoint).toBeUndefined();
        },
    );

    it('ranks candidates, skips failed confirmations without rescanning, and keeps full-mode solution semantics', async () => {
        const source = game({ id: 'ranked-first', pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *' });
        const board = new Chess(); board.loadPgn(source.pgn);
        const moves = board.history({ verbose: true });
        const scanned: string[] = [];
        const confirmed: string[] = [];
        const engine = new FixtureEngine(({ fen, purpose }) => {
            if (purpose === 'GAME_SCAN') scanned.push(fen);
            const chess = new Chess(fen);
            const move = chess.moves({ verbose: true })[0]!;
            const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
            const index = moves.findIndex(item => item.before === fen);
            return result({ fen, bestMove: uci, pv: [uci], cp: chess.turn() === 'b' ? 0 : index === 2 ? 600 : index === 4 ? 400 : 200 });
        }, ({ fen }) => {
            confirmed.push(fen);
            if (fen !== moves[0]!.before) throw new Error('Candidate evidence unavailable');
            return multi(fen, new Chess(fen).moves({ verbose: true }).slice(0, 3)
                .map((move, index) => ({ move: `${move.from}${move.to}${move.promotion ?? ''}`, cp: 200 - index * 200 })));
        });
        const args = { games: [source], selectedGameIds: new Set([source.id]), engine, options: baseOptions };
        const first = await extractTrainingMomentsFromGames({ ...args, strategy: 'FIRST_PUZZLE' });
        expect(scanned).toHaveLength(7);
        expect(new Set(scanned).size).toBe(7);
        expect(confirmed).toEqual([moves[2]!.before, moves[4]!.before, moves[0]!.before]);
        expect(first.moments.map(moment => moment.decisionPly)).toEqual([0]);
        expect(first.manifests).toMatchObject([{ scope: 'TARGETED_DECISION', scanComplete: true, extractionComplete: false }]);
        const full = await extractTrainingMomentsFromGames({ ...args, strategy: 'FULL_GAME' });
        expect(full.moments.map(moment => moment.solution.solutionHash)).toEqual(first.moments.map(moment => moment.solution.solutionHash));
        expect(full.manifests).toMatchObject([{ scope: 'FULL_GAME', complete: true }]);
    });

    it('reports a setup position beginning with Black at relative ply zero', async () => {
        const start = '7k/8/5Q2/8/6K1/8/8/8 b - - 0 42';
        const source = game({ id: 'black-setup-first', pgn: `[SetUp "1"]\n[FEN "${start}"]\n\n42... Kg8 *`, white: 'opponent', black: 'adam', userSide: 'black' });
        const engine = new FixtureEngine(({ fen }) => {
            const move = new Chess(fen).moves({ verbose: true })[0]!;
            const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
            return result({ fen, bestMove: uci, pv: [uci], cp: 0 });
        }, ({ fen }) => multi(fen, []));
        const progress = vi.fn();
        await extractTrainingMomentsFromGames({ games: [source], selectedGameIds: new Set([source.id]),
            engine, strategy: 'FIRST_PUZZLE', onProgress: progress, options: baseOptions });
        expect(progress.mock.calls[0]![0]).toMatchObject({ ply: 0, plyCount: 1, fen: start,
            previousFen: undefined, positionHistory: [], userSide: 'black' });
    });

    it('cancels at the scan-to-confirmation boundary before starting a fresh engine request', async () => {
        const source = game({ id: 'cancel-first', pgn: '1. e4 *' });
        const controller = new AbortController();
        const confirm = vi.fn(({ fen }: { fen: string }) => multi(fen, []));
        const engine = new FixtureEngine(({ fen }) => {
            const board = new Chess(fen); const move = board.moves({ verbose: true })[0]!;
            const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
            return result({ fen, bestMove: uci, pv: [uci], cp: board.turn() === 'w' ? 200 : 0 });
        }, confirm);
        await expect(extractTrainingMomentsFromGames({ games: [source], selectedGameIds: new Set([source.id]),
            engine, strategy: 'FIRST_PUZZLE', signal: controller.signal,
            onProgress: item => { if (item.phase === 'confirming') controller.abort(); }, options: baseOptions,
        })).rejects.toThrow('Analysis aborted');
        expect(confirm).not.toHaveBeenCalled();
    });

    it.each(['FULL_GAME', 'FIRST_PUZZLE'] as const)(
        '%s does not attribute an earlier player loss to an opponent with invalid evidence', async strategy => {
            const source = game({ id: 'invalid-opponent', pgn: '1. e4 e5 2. Nf3 *' });
            const board = new Chess(); board.loadPgn(source.pgn);
            const moves = board.history({ verbose: true });
            const engine = new FixtureEngine(({ fen }) => {
                if (fen === moves[1]!.before) return result({ fen, bestMove: '', pv: [], cp: 0 });
                const chess = new Chess(fen); const move = chess.moves({ verbose: true })[0]!;
                const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
                return result({ fen, bestMove: uci, pv: [uci], cp: chess.turn() === 'b' ? 0 : fen === moves[2]!.before ? 400 : 250 });
            }, ({ fen }) => multi(fen, new Chess(fen).moves({ verbose: true }).slice(0, 3).map((move, index) => ({
                move: `${move.from}${move.to}${move.promotion ?? ''}`, cp: (fen === moves[2]!.before ? 400 : 250) - index * 200,
            }))));
            const output = await extractTrainingMomentsFromGames({ games: [source], selectedGameIds: new Set([source.id]),
                engine, strategy, options: baseOptions });
            const moment = output.moments.find(item => item.decisionPly === 2);
            expect(moment).toBeDefined();
            expect(moment!.sourceKinds).toEqual(['MY_MISTAKE']);
            expect(moment!.lessonKinds).not.toContain('PUNISH_MISTAKE');
        },
    );

    it('rejects FIRST_PUZZLE combined with resumable extraction', async () => {
        const source = game({ id: 'first-scope', pgn: '1. e4 *' });
        await expect(extractTrainingMomentsFromGames({
            games: [source], selectedGameIds: new Set([source.id]), engine: {} as StockfishEngine,
            strategy: 'FIRST_PUZZLE', shouldYield: () => true,
        })).rejects.toThrow('FIRST_PUZZLE does not support full-game checkpoints');
    });

    it('resumes a single-game extraction from a persisted ply checkpoint', async () => {
        const source = game({
            id: 'resumable-game',
            pgn: '1. e4 e5 2. Nf3 Nc6 *',
        });
        const engine = new FixtureEngine(
            ({ fen }) => {
                const chess = new Chess(fen);
                const move = chess.moves({ verbose: true })[0];
                if (!move) {
                    return result({ fen, bestMove: '', pv: [], cp: 0 });
                }
                const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
                return result({
                    fen,
                    bestMove: uci,
                    pv: [uci],
                    cp: 0,
                });
            },
            ({ fen }) => multi(fen, []),
        );
        const args = {
            games: [source],
            selectedGameIds: new Set(['resumable-game']),
            engine,
            options: {
                ...baseOptions,
                returnAnalysis: true,
            },
        };

        const firstSlice = await extractTrainingMomentsFromGames({
            ...args,
            shouldYield: () => true,
        });
        expect(firstSlice.checkpoint).toMatchObject({
            version: 1,
            gameId: 'resumable-game',
            nextPly: 0,
            pendingScan: true,
            expectedPlies: 4,
        });

        const resumed = await extractTrainingMomentsFromGames({
            ...args,
            checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(firstSlice.checkpoint))),
        });
        const uninterrupted = await extractTrainingMomentsFromGames(args);

        expect(resumed.checkpoint).toBeUndefined();
        expect(resumed.moments).toEqual(uninterrupted.moments);
        expect(resumed.manifests).toEqual(uninterrupted.manifests);
        expect(resumed.analysis?.get('resumable-game')?.moves).toEqual(
            uninterrupted.analysis?.get('resumable-game')?.moves,
        );
        expect(
            resumed.analysis?.get('resumable-game')?.trainingExtraction,
        ).toEqual(
            uninterrupted.analysis?.get('resumable-game')?.trainingExtraction,
        );
    });

    it('keeps adjacent scan evidence across repeated server checkpoint round trips', async () => {
        const source = game({ id: 'many-slices', pgn: '1. e4 e5 2. Nf3 Nc6 *' });
        const engine = new FixtureEngine(({ fen }) => {
            const move = new Chess(fen).moves({ verbose: true })[0]!;
            const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
            return result({ fen, bestMove: uci, pv: [uci], cp: 0 });
        }, ({ fen }) => multi(fen, []));
        const scan = vi.spyOn(engine, 'evalPosition');
        const args = { games: [source], selectedGameIds: new Set([source.id]), engine,
            options: { ...baseOptions, returnAnalysis: true }, shouldYield: () => true };
        let output = await extractTrainingMomentsFromGames(args);
        for (let count = 0; output.checkpoint && count < 20; count++) {
            output = await extractTrainingMomentsFromGames({ ...args,
                checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(output.checkpoint))) });
        }
        expect(output.checkpoint).toBeUndefined();
        expect(output.manifests).toMatchObject([{ complete: true, scannedPlies: 4 }]);
        expect(output.analysis?.get(source.id)?.moves).toHaveLength(4);
        expect(scan.mock.calls.filter(([request]) => request.purpose === 'GAME_SCAN')).toHaveLength(5);
    });

    it('escalates near-threshold confirmation and records a saved-decision receipt', async () => {
        const start = new Chess().fen();
        const requestedConfirmationNodes: number[] = [];
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'd2d4',
                          pv: ['d2d4'],
                          cp: 110,
                      })
                    : result({
                          fen,
                          bestMove: 'e7e5',
                          pv: ['e7e5'],
                          cp: 0,
                      }),
            ({ fen, nodes }) => {
                requestedConfirmationNodes.push(nodes ?? 0);
                return multi(fen, [
                    { move: 'd2d4', cp: 110 },
                    { move: 'g1f3', cp: 60 },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'adaptive-confirmation', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['adaptive-confirmation']),
            engine,
            options: {
                nodesPerPosition: 100,
                confirmNodes: 200,
                maxConfirmationNodes: 800,
                minWinningChanceLoss: 0.09,
                fallbackMinCpLoss: 100,
                returnAnalysis: true,
                verifyContinuations: false,
            },
        });

        expect(requestedConfirmationNodes).toEqual([200, 400, 800]);
        expect(output.moments).toHaveLength(1);
        expect(
            output.analysis?.get('adaptive-confirmation')?.trainingExtraction
                .decisions,
        ).toMatchObject([
            {
                ply: 0,
                status: 'SAVED',
                reason: 'MISTAKE_CONFIRMED',
                confirmation: {
                    stable: true,
                    termination: 'STABLE',
                    passes: [{ nodes: 200 }, { nodes: 400 }, { nodes: 800 }],
                },
            },
        ]);
    });

    it('keeps a repeatedly disagreeing confirmation unresolved at the hard cap', async () => {
        const start = new Chess().fen();
        const scores = new Map([
            [200, 100],
            [400, 20],
            [800, 100],
        ]);
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'd2d4',
                          pv: ['d2d4'],
                          cp: 100,
                      })
                    : result({
                          fen,
                          bestMove: 'e7e5',
                          pv: ['e7e5'],
                          cp: 0,
                      }),
            ({ fen, nodes }) =>
                multi(fen, [
                    {
                        move: 'd2d4',
                        cp: scores.get(nodes ?? 0) ?? 100,
                    },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'unstable-confirmation', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['unstable-confirmation']),
            engine,
            options: {
                nodesPerPosition: 100,
                confirmNodes: 200,
                maxConfirmationNodes: 800,
                minWinningChanceLoss: 0.09,
                fallbackMinCpLoss: 100,
                returnAnalysis: true,
                verifyContinuations: false,
            },
        });

        expect(output.moments).toHaveLength(0);
        expect(
            output.analysis?.get('unstable-confirmation')?.trainingExtraction
                .decisions[0],
        ).toMatchObject({
            status: 'UNRESOLVED',
            reason: 'MISTAKE_COMPARISON_UNRESOLVED',
            confirmation: {
                stable: false,
                termination: 'MAX_BUDGET_UNSTABLE',
            },
        });
    });

    it('recognizes en passant as a capture when tagging themes', () => {
        const fen =
            'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';

        expect(tacticalMoveFacts(new Chess(fen), 'e5d6')).toEqual({
            isCheck: false,
            isCapture: true,
            isPromotion: false,
        });
    });

    it('retains a quiet mistake moment and accepts equivalent solutions', async () => {
        const start = new Chess().fen();
        const after = new Chess();
        after.move('e4');
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'e2e3',
                          pv: ['e2e3', 'e7e5'],
                          cp: 100,
                      })
                    : result({
                          fen,
                          bestMove: 'e7e5',
                          pv: ['e7e5', 'g1f3'],
                          cp: 200,
                      }),
            ({ fen }) =>
                multi(fen, [
                    { move: 'e2e3', pv: ['e2e3', 'e7e5'], cp: 100 },
                    { move: 'd2d3', pv: ['d2d3', 'd7d5'], cp: 95 },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'quiet', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['quiet']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            sourceKinds: ['MY_MISTAKE'],
            lessonKinds: ['SAVE_DRAW'],
            solution: {
                bestMoveUci: 'e2e3',
                acceptedMovesUci: ['e2e3', 'd2d3'],
            },
        });
        expect(output.moments[0]?.themes).toContain('quietMove');
        expect(output.moments[0]?.solution.solutionHash).toBe(
            solutionSemanticsHash(output.moments[0]!.solution),
        );
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ).ok,
        ).toBe(true);
    });

    it('emits one assessment per root move when MultiPV repeats its best move', async () => {
        const start = new Chess().fen();
        const after = new Chess();
        after.move('e4');
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'e2e3',
                          pv: ['e2e3', 'e7e5'],
                          cp: 100,
                      })
                    : result({
                          fen,
                          bestMove: 'e7e5',
                          pv: ['e7e5', 'g1f3'],
                          cp: 200,
                      }),
            ({ fen }) =>
                multi(fen, [
                    { move: 'e2e3', cp: 100 },
                    { move: 'e2e3', cp: 100 },
                    { move: 'd2d3', cp: 95 },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'duplicate-root', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['duplicate-root']),
            engine,
            options: {
                ...baseOptions,
                verifyContinuations: true,
                verificationMaxPlies: 1,
                multiPv: 3,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution.moveAssessments).toMatchObject([
            { decisionIndex: 0, moveUci: 'e2e3', grade: 'BEST' },
            { decisionIndex: 0, moveUci: 'd2d3', grade: 'BEST' },
            { decisionIndex: 0, moveUci: 'e2e4', grade: 'REPEATED_MISTAKE' },
        ]);
        expect(
            new Set(
                output.moments[0]?.solution.moveAssessments.map(
                    (assessment) =>
                        `${assessment.decisionIndex}:${assessment.positionKey}:${assessment.moveUci}`,
                ),
            ).size,
        ).toBe(output.moments[0]?.solution.moveAssessments.length);
    });

    it('keeps a move that completes the third source-game occurrence as an exact draw through confirmation', async () => {
        const targetRoot =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const engine = new FixtureEngine(
            ({ fen }) => {
                if (fen === targetRoot) {
                    return result({
                        fen,
                        bestMove: 'f6e4',
                        pv: ['f6e4', 'g1f3'],
                        cp: 300,
                    });
                }
                const first = new Chess(fen).moves({
                    verbose: true,
                })[0];
                return result({
                    fen,
                    bestMove: first?.lan ?? '',
                    pv: first ? [first.lan] : [],
                    cp: 0,
                });
            },
            ({ fen }) => {
                if (fen !== targetRoot) {
                    throw new Error(`Unexpected MultiPV FEN ${fen}`);
                }
                return multi(fen, [
                    {
                        move: 'f6e4',
                        pv: ['f6e4', 'g1f3'],
                        cp: 300,
                    },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'threefold-loss',
                    white: 'opponent',
                    black: 'adam',
                    pgn: '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2',
                }),
            ],
            selectedGameIds: new Set(['threefold-loss']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 500,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            decisionPly: 7,
            originalMoveUci: 'f6g8',
            positionHistory: expect.arrayContaining([new Chess().fen()]),
            originalDecision: {
                scoreAfter: {
                    kind: 'cp',
                    cp: expect.any(Number),
                    pov: 'WHITE',
                },
            },
        });
        expect(output.moments[0]?.positionHistory).toHaveLength(7);
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ).ok,
        ).toBe(true);
    });

    it('finds an omitted legal repetition-saving alternative during scan and confirmation', async () => {
        const targetRoot =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const targetAfter = afterUci(targetRoot, 'e7e6');
        const engine = new FixtureEngine(
            ({ fen }) => {
                if (fen === targetRoot) {
                    return result({
                        fen,
                        bestMove: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -300,
                    });
                }
                if (fen === targetAfter) {
                    return result({
                        fen,
                        bestMove: 'g1f3',
                        pv: ['g1f3', 'b8c6'],
                        cp: 400,
                    });
                }
                const first = new Chess(fen).moves({
                    verbose: true,
                })[0];
                return result({
                    fen,
                    bestMove: first?.lan ?? '',
                    pv: first ? [first.lan] : [],
                    cp: 0,
                });
            },
            ({ fen }) => {
                if (fen !== targetRoot) {
                    throw new Error(`Unexpected MultiPV FEN ${fen}`);
                }
                return multi(fen, [
                    {
                        move: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -300,
                    },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'threefold-save',
                    white: 'opponent',
                    black: 'adam',
                    pgn: '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 e6 *',
                }),
            ],
            selectedGameIds: new Set(['threefold-save']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 500,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            decisionPly: 7,
            originalMoveUci: 'e7e6',
            lessonKinds: ['SAVE_DRAW'],
            solution: {
                bestMoveUci: 'f6g8',
                acceptedMovesUci: ['f6g8'],
                scoreAtStart: {
                    kind: 'cp',
                    cp: expect.any(Number),
                    pov: 'WHITE',
                },
                moveAssessments: expect.arrayContaining([
                    expect.objectContaining({
                        moveUci: 'f6g8',
                        scoreAfter: {
                            kind: 'cp',
                            cp: expect.any(Number),
                            pov: 'WHITE',
                        },
                    }),
                ]),
            },
        });
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ).ok,
        ).toBe(true);
    });

    it('persists a complete GOOD engine assessment beside a RULE-best repetition save', async () => {
        const targetRoot =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const targetAfter = afterUci(targetRoot, 'e7e6');
        const engine = new FixtureEngine(
            ({ fen }) => {
                if (fen === targetRoot) {
                    return result({
                        fen,
                        bestMove: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -30,
                    });
                }
                if (fen === targetAfter) {
                    return result({
                        fen,
                        bestMove: 'g1f3',
                        pv: ['g1f3', 'b8c6'],
                        cp: 400,
                    });
                }
                const first = new Chess(fen).moves({
                    verbose: true,
                })[0];
                return result({
                    fen,
                    bestMove: first?.lan ?? '',
                    pv: first ? [first.lan] : [],
                    cp: 0,
                });
            },
            ({ fen }) => {
                if (fen !== targetRoot) {
                    throw new Error(`Unexpected MultiPV FEN ${fen}`);
                }
                return multi(fen, [
                    {
                        move: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -30,
                    },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'mixed-rule-engine',
                    white: 'opponent',
                    black: 'adam',
                    pgn: '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 e6 *',
                }),
            ],
            selectedGameIds: new Set(['mixed-rule-engine']),
            engine,
            options: {
                ...baseOptions,
                verifyContinuations: true,
                verificationMaxPlies: 1,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution.scoreAtStart).toEqual({
            kind: 'cp',
            cp: expect.any(Number),
            pov: 'WHITE',
        });
        expect(
            output.moments[0]?.solution.moveAssessments.filter((item) =>
                ['BEST', 'STRONG', 'GOOD'].includes(item.grade),
            ),
        ).toMatchObject([
            {
                moveUci: 'f6g8',
                grade: 'BEST',
                scoreAfter: {
                    kind: 'cp',
                    cp: expect.any(Number),
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 0,
                    preservesOutcome: null,
                },
            },
            {
                moveUci: 'e7e5',
                grade: 'STRONG',
                scoreAfter: {
                    kind: 'cp',
                    cp: 30,
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 30,
                    preservesOutcome: null,
                },
            },
        ]);
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ).ok,
        ).toBe(true);
    });

    it('uses the exact tablebase root outcome for scoreAtStart and targetOutcome', async () => {
        const start = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';
        const playedFen = afterUci(start, 'g1g2');
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'g1g3',
                          pv: ['g1g3'],
                          cp: 500,
                      })
                    : result({
                          fen,
                          bestMove: 'c3d3',
                          pv: ['c3d3'],
                          cp: fen === playedFen ? 0 : -500,
                      }),
            ({ fen }) =>
                multi(fen, [
                    {
                        move: 'g1g3',
                        pv: ['g1g3'],
                        cp: 500,
                    },
                ]),
        );
        const evidence: TablebaseEvidence = {
            source: 'LICHESS_SYZYGY',
            fen: start,
            pieceCount: 3,
            wdl: 'WIN',
            category: 'win',
            dtz: 7,
            terminal: {
                checkmate: false,
                stalemate: false,
                insufficientMaterial: false,
            },
            moves: [
                { uci: 'g1g2', wdl: 'DRAW', categoryAfterMove: 'draw' },
                {
                    uci: 'g1g3',
                    wdl: 'WIN',
                    categoryAfterMove: 'loss',
                    dtz: -6,
                },
            ],
            fetchedAt: '2026-01-01T00:00:00.000Z',
        };
        const tablebase: TablebaseProvider = {
            probe: async () => evidence,
        };

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'exact-tablebase-root',
                    pgn: `[SetUp "1"]\n[FEN "${start}"]\n\n1. Rg2 *`,
                }),
            ],
            selectedGameIds: new Set(['exact-tablebase-root']),
            engine,
            tablebase,
            options: {
                ...baseOptions,
                verifyContinuations: true,
                verificationMaxPlies: 1,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution).toMatchObject({
            bestMoveUci: 'g1g3',
            gradingStrategy: 'TABLEBASE',
            scoreAtStart: {
                kind: 'tablebase',
                wdl: 'WIN',
                pov: 'WHITE',
                dtz: -6,
            },
            targetOutcome: {
                kind: 'MAXIMIZE_WINNING_CHANCE',
                score: {
                    kind: 'tablebase',
                    wdl: 'WIN',
                    pov: 'WHITE',
                    dtz: -6,
                },
            },
        });
    });

    it('keeps a complete mate-in-one as an explicit categorical outcome', async () => {
        const start = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
        const after = new Chess(start);
        after.move({ from: 'f7', to: 'f3' });
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'f7f8',
                          pv: ['f7f8'],
                          mate: 1,
                      })
                    : result({
                          fen,
                          bestMove: 'h8g8',
                          pv: ['h8g8', 'f3a8'],
                          cp: 0,
                      }),
            ({ fen }) => multi(fen, [{ move: 'f7f8', pv: ['f7f8'], mate: 1 }]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'mate-one',
                    pgn: `[SetUp "1"]\n[FEN "${start}"]\n\n1. Qf3 *`,
                }),
            ],
            selectedGameIds: new Set(['mate-one']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            solution: {
                bestMoveUci: 'f7f8',
                bestLineUci: ['f7f8'],
                scoreAtStart: {
                    kind: 'mate',
                    winner: 'WHITE',
                },
            },
        });
        expect(output.moments[0]?.themes).toContain('mateIn1');
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ).ok,
        ).toBe(true);
    });

    it('preserves an underpromotion as the canonical best move', async () => {
        const start = '7k/P7/8/8/8/8/8/7K w - - 0 1';
        const after = new Chess(start);
        after.move({ from: 'a7', to: 'a8', promotion: 'q' });
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'a7a8n',
                          pv: ['a7a8n', 'h8g7'],
                          cp: 500,
                      })
                    : result({
                          fen,
                          bestMove: 'h8g7',
                          pv: ['h8g7'],
                          cp: 0,
                      }),
            ({ fen }) =>
                multi(fen, [
                    {
                        move: 'a7a8n',
                        pv: ['a7a8n', 'h8g7'],
                        cp: 500,
                    },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'underpromotion',
                    pgn: `[SetUp "1"]\n[FEN "${start}"]\n\n1. a8=Q+ *`,
                }),
            ],
            selectedGameIds: new Set(['underpromotion']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            originalMoveUci: 'a7a8q',
            solution: {
                bestMoveUci: 'a7a8n',
                acceptedMovesUci: ['a7a8n'],
            },
        });
        expect(output.moments[0]?.themes).toContain('promotion');
    });

    it('keeps a verified sacrifice as lesson metadata rather than filtering it', async () => {
        const start = '3rk3/8/8/8/8/8/8/3QK3 w - - 0 1';
        const after = new Chess(start);
        after.move({ from: 'd1', to: 'c2' });
        const engine = new FixtureEngine(
            ({ fen }) =>
                fen === start
                    ? result({
                          fen,
                          bestMove: 'd1d8',
                          pv: ['d1d8', 'e8d8'],
                          cp: 500,
                      })
                    : result({
                          fen,
                          bestMove: 'd8d1',
                          pv: ['d8d1', 'e1d1'],
                          cp: 0,
                      }),
            ({ fen }) =>
                multi(fen, [
                    {
                        move: 'd1d8',
                        pv: ['d1d8', 'e8d8'],
                        cp: 500,
                    },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'sacrifice',
                    pgn: `[SetUp "1"]\n[FEN "${start}"]\n\n1. Qc2 *`,
                }),
            ],
            selectedGameIds: new Set(['sacrifice']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution.bestMoveUci).toBe('d1d8');
        expect(output.moments[0]?.themes).toContain('sacrifice');
    });

    it('does not call an equivalent non-best reply a missed punishment', async () => {
        const board = new Chess();
        const start = board.fen();
        board.move('e4');
        const afterE4 = board.fen();
        board.move('e5');
        const afterE5 = board.fen();
        board.move('Nf3');
        const afterNf3 = board.fen();

        const evals = new Map<string, EvalResult>([
            [
                start,
                result({
                    fen: start,
                    bestMove: 'e2e4',
                    pv: ['e2e4', 'e7e5'],
                    cp: 0,
                }),
            ],
            [
                afterE4,
                result({
                    fen: afterE4,
                    bestMove: 'c7c5',
                    pv: ['c7c5', 'g1f3'],
                    cp: 0,
                }),
            ],
            [
                afterE5,
                result({
                    fen: afterE5,
                    bestMove: 'd2d4',
                    pv: ['d2d4', 'e5d4'],
                    cp: 300,
                }),
            ],
            [
                afterNf3,
                result({
                    fen: afterNf3,
                    bestMove: 'b8c6',
                    pv: ['b8c6', 'd2d4'],
                    cp: -295,
                }),
            ],
        ]);
        const engine = new FixtureEngine(
            ({ fen }) => {
                const value = evals.get(fen);
                if (!value) throw new Error(`Unexpected FEN ${fen}`);
                return value;
            },
            ({ fen }) => multi(fen, [{ move: 'd2d4', cp: 300 }]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'equivalent', pgn: '1. e4 e5 2. Nf3 *' })],
            selectedGameIds: new Set(['equivalent']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(0);
    });

    it('merges avoid and missed-opportunity evidence into one user decision', async () => {
        const board = new Chess();
        const start = board.fen();
        board.move('e4');
        const afterE4 = board.fen();
        board.move('e5');
        const afterE5 = board.fen();
        board.move('Nf3');
        const afterNf3 = board.fen();
        const evals = new Map<string, EvalResult>([
            [
                start,
                result({
                    fen: start,
                    bestMove: 'e2e4',
                    pv: ['e2e4', 'e7e5'],
                    cp: 0,
                }),
            ],
            [
                afterE4,
                result({
                    fen: afterE4,
                    bestMove: 'c7c5',
                    pv: ['c7c5', 'g1f3'],
                    cp: 0,
                }),
            ],
            [
                afterE5,
                result({
                    fen: afterE5,
                    bestMove: 'd2d4',
                    pv: ['d2d4', 'e5d4'],
                    cp: 300,
                }),
            ],
            [
                afterNf3,
                result({
                    fen: afterNf3,
                    bestMove: 'b8c6',
                    pv: ['b8c6', 'd2d4'],
                    cp: 0,
                }),
            ],
        ]);
        const requestedConfirmationNodes: number[] = [];
        const engine = new FixtureEngine(
            ({ fen }) => {
                const value = evals.get(fen);
                if (!value) throw new Error(`Unexpected FEN ${fen}`);
                return value;
            },
            ({ fen, nodes }) => {
                requestedConfirmationNodes.push(nodes ?? 0);
                return multi(fen, [
                    { move: 'd2d4', pv: ['d2d4', 'e5d4'], cp: 300 },
                    { move: 'f1c4', pv: ['f1c4', 'b8c6'], cp: 280 },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'merged', pgn: '1. e4 e5 2. Nf3 *' })],
            selectedGameIds: new Set(['merged']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 200,
                maxConfirmationNodes: 800,
                returnAnalysis: true,
            },
        });

        expect(requestedConfirmationNodes).toEqual([200]);
        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]).toMatchObject({
            decisionPly: 2,
            fen: afterE5,
            sourceKinds: ['MY_MISTAKE', 'MISSED_OPPORTUNITY'],
        });
        expect(output.moments[0]?.lessonKinds).toEqual(
            expect.arrayContaining(['AVOID_MISTAKE', 'PUNISH_MISTAKE']),
        );
        expect(
            output.analysis
                ?.get('merged')
                ?.trainingExtraction.decisions.find(
                    (decision) => decision.ply === 2,
                ),
        ).toMatchObject({
            ply: 2,
            status: 'SAVED',
            confirmation: {
                stable: true,
                termination: 'STABLE',
            },
        });
    });

    it('confirms the user response loss rather than only the preceding opponent mistake', async () => {
        const board = new Chess();
        const start = board.fen();
        board.move('e4');
        const afterE4 = board.fen();
        board.move('e5');
        const afterE5 = board.fen();
        board.move('Nf3');
        const afterNf3 = board.fen();
        const engine = new FixtureEngine(
            ({ fen, nodes }) => {
                const confirmed = (nodes ?? 0) >= 500;
                if (fen === start) {
                    return result({
                        fen,
                        bestMove: 'e2e4',
                        pv: ['e2e4', 'e7e5'],
                        cp: 0,
                    });
                }
                if (fen === afterE4) {
                    return result({
                        fen,
                        bestMove: 'c7c5',
                        pv: ['c7c5', 'g1f3'],
                        cp: 0,
                    });
                }
                if (fen === afterE5) {
                    return result({
                        fen,
                        bestMove: 'd2d4',
                        pv: ['d2d4', 'e5d4'],
                        cp: confirmed ? 80 : 300,
                    });
                }
                if (fen === afterNf3) {
                    return result({
                        fen,
                        bestMove: 'b8c6',
                        pv: ['b8c6', 'd2d4'],
                        cp: confirmed ? -70 : 0,
                    });
                }
                throw new Error(`Unexpected FEN ${fen}`);
            },
            ({ fen, nodes }) => {
                if (fen !== afterE5) {
                    throw new Error(`Unexpected MultiPV FEN ${fen}`);
                }
                return multi(fen, [
                    {
                        move: 'd2d4',
                        pv: ['d2d4', 'e5d4'],
                        cp: (nodes ?? 0) >= 500 ? 80 : 300,
                    },
                    {
                        move: 'f1c4',
                        pv: ['f1c4', 'b8c6'],
                        cp: (nodes ?? 0) >= 500 ? 75 : 280,
                    },
                ]);
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'response-confirm', pgn: '1. e4 e5 2. Nf3 *' })],
            selectedGameIds: new Set(['response-confirm']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 500,
            },
        });

        expect(output.moments).toHaveLength(0);
        expect(output.manifests[0]?.complete).toBe(true);
    });

    it('rejects a shallow candidate whose before/after loss disappears on confirmation', async () => {
        const start = new Chess().fen();
        const after = new Chess();
        after.move('e4');
        const engine = new FixtureEngine(
            ({ fen, nodes }) => {
                const confirmed = (nodes ?? 0) >= 500;
                if (fen === start) {
                    return result({
                        fen,
                        bestMove: 'd2d4',
                        pv: ['d2d4', 'd7d5'],
                        cp: confirmed ? 80 : 300,
                    });
                }
                return result({
                    fen,
                    bestMove: 'e7e5',
                    pv: ['e7e5', 'g1f3'],
                    cp: confirmed ? -70 : 0,
                });
            },
            ({ fen, nodes }) =>
                multi(fen, [
                    {
                        move: 'd2d4',
                        pv: ['d2d4', 'd7d5'],
                        cp: (nodes ?? 0) >= 500 ? 80 : 300,
                    },
                    { move: 'g1f3', pv: ['g1f3', 'd7d5'], cp: 75 },
                ]),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'unstable', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['unstable']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 500,
            },
        });

        expect(output.moments).toHaveLength(0);
    });

    it('emits an explicit incomplete manifest when the training side cannot be resolved', async () => {
        const engine = new FixtureEngine(
            () => {
                throw new Error('engine must not run');
            },
            () => {
                throw new Error('engine must not run');
            },
        );

        const output = await extractTrainingMomentsFromGames({
            games: [
                game({
                    id: 'unresolved',
                    pgn: '1. e4 *',
                    sourceUsername: 'someone-else',
                }),
            ],
            selectedGameIds: new Set(['unresolved']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(0);
        expect(output.manifests).toEqual([
            expect.objectContaining({
                complete: false,
                sourceGameId: 'unresolved',
                scannedPlies: 0,
                expectedPlies: 1,
                termination: 'USER_SIDE_UNRESOLVED',
            }),
        ]);
        expect(output.manifests[0]?.errors).not.toHaveLength(0);
    });

    it('completes mandatory work with explicit unresolved engine evidence', async () => {
        const engine = new FixtureEngine(
            ({ fen }) =>
                result({
                    fen,
                    bestMove: '',
                    pv: [],
                    cp: 0,
                }),
            ({ fen }) => multi(fen, []),
        );

        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'missing-evidence', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['missing-evidence']),
            engine,
            options: baseOptions,
        });

        expect(output.moments).toHaveLength(0);
        expect(output.manifests).toEqual([
            expect.objectContaining({
                complete: true,
                scannedPlies: 1,
                expectedPlies: 1,
                termination: 'COMPLETED',
                decisionOutcomes: [
                    {
                        decisionPly: 0,
                        status: 'UNRESOLVED',
                        reason: 'ENGINE_EVIDENCE_INVALID',
                    },
                ],
            }),
        ]);
        expect(output.manifests[0]?.errors).toEqual([
            expect.stringContaining('missing exact engine evidence'),
        ]);
    });
});

describe('decision evidence pipeline regressions', () => {
    it('scans exactly N+1 history contexts for a quiet N-ply source', async () => {
        const requests: Array<AnalysisLimit & { fen: string }> = [];
        const engine = new FixtureEngine(
            (opts) => {
                requests.push(opts);
                const first = new Chess(opts.fen).moves({ verbose: true })[0]!;
                return result({
                    fen: opts.fen,
                    bestMove: first.lan,
                    pv: [first.lan],
                    cp: 0,
                });
            },
            () => {
                throw Error('no candidate');
            },
        );
        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'scan-count', pgn: '1. e4 e5 2. Nf3 Nc6 *' })],
            selectedGameIds: new Set(['scan-count']),
            engine,
            options: baseOptions,
        });
        expect(output.manifests[0]?.complete).toBe(true);
        expect(requests).toHaveLength(5);
        expect(requests.map((item) => item.previousFens?.length)).toEqual([
            0, 1, 2, 3, 4,
        ]);
        expect(
            requests.every(
                (item) =>
                    item.purpose === 'GAME_SCAN' &&
                    item.reuse === 'REUSE_ALLOWED',
            ),
        ).toBe(true);
    });
    it('keeps a cp-close but matched-WDL-bad original classified by the same model through persistence validation', async () => {
        const start = new Chess().fen();
        const engine = new FixtureEngine(
            ({ fen }) => ({
                ...result({
                    fen,
                    bestMove: fen === start ? 'd2d4' : 'e7e5',
                    pv: [fen === start ? 'd2d4' : 'e7e5'],
                    cp: fen === start ? 100 : -50,
                }),
                wdl:
                    fen === start
                        ? { win: 900, draw: 100, loss: 0 }
                        : { win: 400, draw: 200, loss: 400 },
            }),
            ({ fen }) => ({
                ...multi(fen, [{ move: 'd2d4', cp: 100 }]),
                lines: [
                    {
                        multipv: 1,
                        pvUci: ['d2d4'],
                        score: { type: 'cp', value: 100 },
                        wdl: { win: 900, draw: 100, loss: 0 },
                    },
                ],
            }),
        );
        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'wdl-original', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['wdl-original']),
            engine,
            options: {
                ...baseOptions,
                confirmNodes: 200,
                maxConfirmationNodes: 800,
            },
        });
        expect(output.moments).toHaveLength(1);
        const original = output.moments[0]!.solution.moveAssessments.find(
            (item) => item.moveUci === 'e2e4',
        );
        expect(original).toMatchObject({
            grade: 'REPEATED_MISTAKE',
            evidence: {
                evidenceModel: 'MATCHED_WDL',
                bestGapCp: 50,
                bestGapWinChance: 0.45,
            },
        });
        expect(output.moments[0]!.solution.trainable).toBe(true);
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments)),
            ),
        ).toMatchObject({ ok: true });
    });
    it('escalates when the actual original GOOD/bad conclusion changes despite both passing the candidate signal', async () => {
        const start = new Chess().fen();
        const budgets: number[] = [];
        const engine = new FixtureEngine(
            ({ fen, nodes }) =>
                result({
                    fen,
                    bestMove: fen === start ? 'd2d4' : 'e7e5',
                    pv: [fen === start ? 'd2d4' : 'e7e5'],
                    cp: fen === start ? 200 : nodes === 100 ? -120 : -75,
                }),
            ({ fen, nodes }) => {
                budgets.push(nodes!);
                return multi(fen, [{ move: 'd2d4', cp: 200 }]);
            },
        );
        const output = await extractTrainingMomentsFromGames({
            games: [game({ id: 'grade-boundary', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['grade-boundary']),
            engine,
            options: {
                ...baseOptions,
                nodesPerPosition: 100,
                confirmNodes: 200,
                maxConfirmationNodes: 800,
            },
        });
        expect(budgets).toEqual([200, 400]);
        expect(output.moments[0]?.solution.trainable).toBe(true);
    });
    it('resumes a completed paired confirmation without repeating scan, original search or metadata', async () => {
        const start = new Chess().fen();
        let paired = false;
        let rootSearches = 0;
        const engine = new FixtureEngine(
            ({ fen }) =>
                result({
                    fen,
                    bestMove: fen === start ? 'd2d4' : 'e7e5',
                    pv: [fen === start ? 'd2d4' : 'e7e5'],
                    cp: fen === start ? 250 : 0,
                }),
            ({ fen }) => {
                rootSearches++;
                paired = true;
                return multi(fen, [{ move: 'd2d4', cp: 250 }]);
            },
        );
        const args = {
            games: [game({ id: 'paired-checkpoint', pgn: '1. e4 *' })],
            selectedGameIds: new Set(['paired-checkpoint']),
            engine,
            options: { ...baseOptions, returnAnalysis: true },
        };
        const first = await extractTrainingMomentsFromGames({
            ...args,
            shouldYield: () => paired,
        });
        expect(first.checkpoint?.pendingConfirmation).toBeDefined();
        expect(first.checkpoint?.gameAnalysis).toHaveLength(1);
        const resumed = await extractTrainingMomentsFromGames({
            ...args,
            checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(first.checkpoint))),
        });
        expect(rootSearches).toBe(1);
        expect(resumed.analysis?.get('paired-checkpoint')?.moves).toHaveLength(
            1,
        );
        expect(resumed.moments).toHaveLength(1);
    });
});

it('requires concrete lesson support only for a saturated practical cp signal', async () => {
    const start = new Chess().fen();
    const engine = new FixtureEngine(
        ({ fen }) => ({
            ...result({
                fen,
                bestMove: fen === start ? 'd2d4' : 'e7e5',
                pv: [fen === start ? 'd2d4' : 'e7e5'],
                cp: fen === start ? 1000 : -750,
            }),
            wdl:
                fen === start
                    ? { win: 1000, draw: 0, loss: 0 }
                    : { win: 0, draw: 0, loss: 1000 },
        }),
        ({ fen }) => ({
            ...multi(fen, [{ move: 'd2d4', cp: 1000 }]),
            lines: [
                {
                    multipv: 1,
                    pvUci: ['d2d4'],
                    score: { type: 'cp', value: 1000 },
                    wdl: { win: 1000, draw: 0, loss: 0 },
                },
            ],
        }),
    );
    const output = await extractTrainingMomentsFromGames({
        games: [game({ id: 'saturated-no-lesson', pgn: '1. e4 *' })],
        selectedGameIds: new Set(['saturated-no-lesson']),
        engine,
        options: { ...baseOptions, returnAnalysis: true },
    });
    expect(output.moments).toEqual([]);
    expect(
        output.analysis?.get('saturated-no-lesson')?.trainingExtraction
            .decisions,
    ).toMatchObject([{ reason: 'NO_SUPPORTED_PRACTICAL_LESSON' }]);
    expect(output.manifests[0]?.decisionOutcomes).toMatchObject([
        { status: 'UNRESOLVED' },
    ]);
});

it('serializes independently graded nested user nodes with their own coverage and assessments', async () => {
    const start = new Chess().fen();
    const d4 = afterUci(start, 'd2d4');
    const d5 = afterUci(d4, 'd7d5');
    const engine = new FixtureEngine(
        ({ fen }) =>
            result({
                fen,
                bestMove: fen === start ? 'd2d4' : 'e7e5',
                pv: [fen === start ? 'd2d4' : 'e7e5'],
                cp: fen === start ? 200 : 0,
            }),
        ({ fen }) =>
            fen === start
                ? multi(fen, [{ move: 'd2d4', cp: 200 }])
                : fen === d4
                  ? multi(fen, [{ move: 'd7d5', cp: -200 }])
                  : fen === d5
                    ? multi(fen, [
                          { move: 'g1f3', cp: 200 },
                          { move: 'c2c4', cp: 180 },
                      ])
                    : multi(fen, []),
    );
    const output = await extractTrainingMomentsFromGames({
        games: [game({ id: 'nested-contract', pgn: '1. e4 *' })],
        selectedGameIds: new Set(['nested-contract']),
        engine,
        options: {
            ...baseOptions,
            verifyContinuations: true,
            verificationMaxPlies: 3,
        },
    });
    expect(output.moments[0]?.solution.continuation.status).toBe(
        'GRADED_BRANCHES_READY',
    );
    expect(
        output.moments[0]?.solution.moveAssessments.filter(
            (item) => item.decisionIndex === 1,
        ),
    ).toHaveLength(2);
    const solution = output.moments[0]!.solution;
    const evidence = solution.evidence as { verifier: Record<string, unknown> };
    const tree = solution.solutionTree as {
        contextId: string;
        branches: unknown[];
        moveEvaluations: unknown[];
    };
    expect(evidence.verifier).not.toHaveProperty('root');
    expect(evidence.verifier.rootContextId).toBe(tree.contextId);
    expect(evidence.verifier).toMatchObject({
        status: 'VERIFIED',
        bounds: { positionsVisited: 3 },
        continuation: { status: 'GRADED_BRANCHES_READY' },
    });
    expect(tree.moveEvaluations).toHaveLength(1);
    expect(tree.branches).toHaveLength(1);
    // Expanding the reference restores the former evidence representation;
    // search metadata, the full nested tree and canonical grading are preserved.
    const { rootContextId, ...metadata } = evidence.verifier;
    expect(rootContextId).toBe(tree.contextId);
    const expanded = {
        ...solution,
        evidence: { ...evidence, verifier: { ...metadata, root: tree } },
    };
    expect(solutionSemanticsHash(solution)).toBe(
        solutionSemanticsHash(expanded),
    );
    expect(Buffer.byteLength(JSON.stringify(solution))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(expanded)),
    );
    expect(
        validateTrainingMomentCandidates(
            JSON.parse(JSON.stringify(output.moments)),
        ),
    ).toMatchObject({ ok: true });
});

it('rejects source continuation after an automatic draw without searching an ended game', async () => {
    const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 150 76';
    const engine = new FixtureEngine(
        () => {
            throw Error('Ended source must not search');
        },
        () => {
            throw Error('Ended source must not search');
        },
    );
    const output = await extractTrainingMomentsFromGames({
        games: [
            game({
                id: 'ended-source',
                pgn: `[SetUp "1"]\n[FEN "${fen}"]\n\n76. Rg2 *`,
            }),
        ],
        selectedGameIds: new Set(['ended-source']),
        engine,
        options: baseOptions,
    });
    expect(output.manifests[0]).toMatchObject({
        complete: false,
        scannedPlies: 0,
        decisionOutcomes: [
            { decisionPly: 0, status: 'UNRESOLVED', reason: 'SOURCE_INVALID' },
        ],
    });
});

it('retains an original forced losing mate below a statistical cp reference when matched WDL confirms the loss', async () => {
    const start = new Chess().fen();
    const engine = new FixtureEngine(
        ({ fen }) => ({
            ...result({
                fen,
                bestMove: fen === start ? 'd2d4' : 'e7e5',
                pv: [fen === start ? 'd2d4' : 'e7e5'],
                ...(fen === start ? { cp: 200 } : { mate: 3 }),
            }),
            wdl:
                fen === start
                    ? { win: 900, draw: 100, loss: 0 }
                    : { win: 1000, draw: 0, loss: 0 },
        }),
        ({ fen }) => ({
            fen,
            bestMoveUci: 'd2d4',
            lines: [
                {
                    multipv: 1,
                    pvUci: ['d2d4'],
                    score: { type: 'cp', value: 200 },
                    wdl: { win: 900, draw: 100, loss: 0 },
                },
            ],
        }),
    );
    const output = await extractTrainingMomentsFromGames({
        games: [game({ id: 'mixed-losing-mate', pgn: '1. e4 *' })],
        selectedGameIds: new Set(['mixed-losing-mate']),
        engine,
        options: {
            ...baseOptions,
            confirmNodes: 200,
            maxConfirmationNodes: 800,
        },
    });
    expect(output.moments).toHaveLength(1);
    expect(
        output.moments[0]?.solution.moveAssessments.find(
            (item) => item.moveUci === 'e2e4',
        ),
    ).toMatchObject({
        grade: 'REPEATED_MISTAKE',
        scoreAfter: { kind: 'mate', winner: 'BLACK' },
        evidence: {
            bestGapCp: null,
            evidenceModel: 'MATCHED_WDL',
            referenceOutdated: false,
        },
    });
    expect(
        validateTrainingMomentCandidates(
            JSON.parse(JSON.stringify(output.moments)),
        ),
    ).toMatchObject({ ok: true });
});
