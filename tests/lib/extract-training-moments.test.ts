import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
    extractTrainingMomentsFromGames,
    tacticalMoveFacts,
    type TrainingMomentExtractionOptions,
} from '@/lib/analysis/extractTrainingMoments';
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
import { solutionSemanticsHash } from '@/lib/training/contracts';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import type { NormalizedGame } from '@/lib/types/game';

type EvalFactory = (
    limit: AnalysisLimit & { fen: string }
) => EvalResult | Promise<EvalResult>;
type MultiFactory = (
    limit: AnalysisLimit & { fen: string; multiPv?: number }
) => MultiPvResult | Promise<MultiPvResult>;

class FixtureEngine implements StockfishEngine {
    constructor(
        private readonly evalFactory: EvalFactory,
        private readonly multiFactory: MultiFactory
    ) {}

    evalPosition(opts: AnalysisLimit & { fen: string }) {
        return Promise.resolve(this.evalFactory(opts));
    }

    analyzeMultiPv(
        opts: AnalysisLimit & { fen: string; multiPv?: number }
    ) {
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
    }>
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

describe('canonical training-moment extraction v2', () => {
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
            ({ fen }) => multi(fen, [])
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
            nextPly: 1,
            expectedPlies: 4,
        });

        const resumed = await extractTrainingMomentsFromGames({
            ...args,
            checkpoint: JSON.parse(JSON.stringify(firstSlice.checkpoint)),
        });
        const uninterrupted = await extractTrainingMomentsFromGames(args);

        expect(resumed.checkpoint).toBeUndefined();
        expect(resumed.moments).toEqual(uninterrupted.moments);
        expect(resumed.manifests).toEqual(uninterrupted.manifests);
        expect(resumed.analysis?.get('resumable-game')?.moves).toEqual(
            uninterrupted.analysis?.get('resumable-game')?.moves
        );
        expect(
            resumed.analysis?.get('resumable-game')?.trainingExtraction
        ).toEqual(
            uninterrupted.analysis?.get('resumable-game')?.trainingExtraction
        );
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
                          cp: 100,
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
                    { move: 'd2d4', cp: 100 },
                    { move: 'g1f3', cp: 60 },
                ]);
            }
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
            output.analysis?.get('adaptive-confirmation')
                ?.trainingExtraction.decisions
        ).toMatchObject([
            {
                ply: 0,
                status: 'SAVED',
                reason: 'SAVED',
                confirmation: {
                    stable: true,
                    termination: 'STABLE',
                    passes: [
                        { nodes: 200 },
                        { nodes: 400 },
                        { nodes: 800 },
                    ],
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
                ])
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
            output.analysis?.get('unstable-confirmation')
                ?.trainingExtraction.decisions[0]
        ).toMatchObject({
            status: 'UNRESOLVED',
            reason: 'VERIFICATION_UNSTABLE',
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
                ])
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
            solutionSemanticsHash(output.moments[0]!.solution)
        );
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments))
            ).ok
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
                ])
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
        ]);
        expect(
            new Set(
                output.moments[0]?.solution.moveAssessments.map(
                    (assessment) =>
                        `${assessment.decisionIndex}:${assessment.positionKey}:${assessment.moveUci}`
                )
            ).size
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
                    throw new Error(
                        `Unexpected MultiPV FEN ${fen}`
                    );
                }
                return multi(fen, [
                    {
                        move: 'f6e4',
                        pv: ['f6e4', 'g1f3'],
                        cp: 300,
                    },
                ]);
            }
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
            positionHistory: expect.arrayContaining([
                new Chess().fen(),
            ]),
            originalDecision: {
                scoreAfter: {
                    kind: 'tablebase',
                    wdl: 'DRAW',
                    pov: 'WHITE',
                },
            },
        });
        expect(output.moments[0]?.positionHistory).toHaveLength(7);
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments))
            ).ok
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
                    throw new Error(
                        `Unexpected MultiPV FEN ${fen}`
                    );
                }
                return multi(fen, [
                    {
                        move: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -300,
                    },
                ]);
            }
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
                    kind: 'tablebase',
                    wdl: 'DRAW',
                    pov: 'WHITE',
                },
                moveAssessments: [
                    {
                        moveUci: 'f6g8',
                        scoreAfter: {
                            kind: 'tablebase',
                            wdl: 'DRAW',
                            pov: 'WHITE',
                        },
                        evidence: {
                            ruleTerminal:
                                'THREEFOLD_REPETITION',
                        },
                    },
                ],
            },
        });
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments))
            ).ok
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
                    throw new Error(
                        `Unexpected MultiPV FEN ${fen}`
                    );
                }
                return multi(fen, [
                    {
                        move: 'e7e5',
                        pv: ['e7e5', 'g1f3'],
                        cp: -30,
                    },
                ]);
            }
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
            selectedGameIds: new Set([
                'mixed-rule-engine',
            ]),
            engine,
            options: {
                ...baseOptions,
                verifyContinuations: true,
                verificationMaxPlies: 1,
            },
        });

        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution.scoreAtStart).toEqual({
            kind: 'tablebase',
            wdl: 'DRAW',
            pov: 'WHITE',
        });
        expect(
            output.moments[0]?.solution.moveAssessments
        ).toMatchObject([
            {
                moveUci: 'f6g8',
                grade: 'BEST',
                scoreAfter: {
                    kind: 'tablebase',
                    wdl: 'DRAW',
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 0,
                    preservesOutcome: true,
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
                    preservesOutcome: true,
                },
            },
        ]);
        expect(
            validateTrainingMomentCandidates(
                JSON.parse(JSON.stringify(output.moments))
            ).ok
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
                ])
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
            ({ fen }) =>
                multi(fen, [{ move: 'f7f8', pv: ['f7f8'], mate: 1 }])
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
                JSON.parse(JSON.stringify(output.moments))
            ).ok
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
                ])
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
                ])
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
            ({ fen }) => multi(fen, [{ move: 'd2d4', cp: 300 }])
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
            }
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
            expect.arrayContaining(['AVOID_MISTAKE', 'PUNISH_MISTAKE'])
        );
        expect(
            output.analysis
                ?.get('merged')
                ?.trainingExtraction.decisions.find(
                    (decision) => decision.ply === 2
                )
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
            }
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
                ])
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
            }
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

    it('never marks a replay complete when a decision could not be analyzed', async () => {
        const engine = new FixtureEngine(
            ({ fen }) =>
                result({
                    fen,
                    bestMove: '',
                    pv: [],
                    cp: 0,
                }),
            ({ fen }) => multi(fen, [])
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
                complete: false,
                scannedPlies: 1,
                expectedPlies: 1,
                termination: 'ANALYSIS_INCOMPLETE',
            }),
        ]);
        expect(output.manifests[0]?.errors).toEqual([
            expect.stringContaining('no usable principal variation'),
        ]);
    });
});
