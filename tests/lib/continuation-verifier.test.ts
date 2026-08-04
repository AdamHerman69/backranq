import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { verifyConditionalContinuation } from '@/lib/analysis/continuationVerifier';
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

type Line = {
    move: string;
    cp: number;
    nodes?: number;
    multipv?: number;
};

class VerifierFixtureEngine implements StockfishEngine {
    readonly calls: Array<{ fen: string; multiPv: number }> = [];
    private readonly alternativesComplete: boolean | undefined;

    constructor(
        private readonly positions: ReadonlyMap<string, Line[]>,
        alternativesComplete: boolean | 'UNKNOWN' = true
    ) {
        this.alternativesComplete =
            alternativesComplete === 'UNKNOWN'
                ? undefined
                : alternativesComplete;
    }

    evalPosition(): Promise<EvalResult> {
        throw new Error('Verifier must use coherent MultiPV analysis');
    }

    async analyzeMultiPv(
        opts: AnalysisLimit & { fen: string; multiPv?: number }
    ): Promise<MultiPvResult> {
        this.calls.push({ fen: opts.fen, multiPv: opts.multiPv ?? 1 });
        const lines = this.positions.get(opts.fen);
        if (!lines) throw new Error(`Missing verifier fixture for ${opts.fen}`);
        const requestedLines = lines.slice(0, opts.multiPv ?? 1);
        return {
            fen: opts.fen,
            bestMoveUci: requestedLines[0]?.move ?? '',
            lines: requestedLines.map((line, index) => ({
                multipv: line.multipv ?? index + 1,
                pvUci: [line.move],
                score: { type: 'cp', value: line.cp },
                depth: opts.depth ?? 18,
                nodes: line.nodes ?? opts.nodes ?? 100_000,
            })),
            ...(this.alternativesComplete == null
                ? {}
                : {
                      alternativesComplete:
                          this.alternativesComplete,
                  }),
        };
    }
}

function after(fen: string, moveUci: string): string {
    const chess = new Chess(fen);
    chess.move({
        from: moveUci.slice(0, 2),
        to: moveUci.slice(2, 4),
        promotion: moveUci.slice(4, 5) || undefined,
    });
    return chess.fen();
}

describe('bounded conditional continuation verifier', () => {
    it('expands a still-acceptable MultiPV frontier beyond four moves', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100 },
                        { move: 'd2d4', cp: 95 },
                        { move: 'g1f3', cp: 90 },
                        { move: 'c2c4', cp: 80 },
                        { move: 'g2g3', cp: 70 },
                        { move: 'b2b3', cp: 0 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 5,
                maxMultiPv: 16,
                maxUserBranches: 16,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(engine.calls.map((call) => call.multiPv)).toEqual([5, 10]);
        expect(verified.acceptedMovesUci).toEqual([
            'e2e4',
            'd2d4',
            'g1f3',
            'c2c4',
            'g2g3',
        ]);
        expect(verified.solutionShape).toBe('MULTIPLE');
        expect(verified.bounds.largestMultiPvRequested).toBe(10);
    });

    it('records practical alternatives at every user decision and best defense at opponent nodes', async () => {
        const root = new Chess().fen();
        const e4 = after(root, 'e2e4');
        const d4 = after(root, 'd2d4');
        const e4e5 = after(e4, 'e7e5');
        const d4d5 = after(d4, 'd7d5');
        const e4e5Nf3 = after(e4e5, 'g1f3');
        const e4e5Bc4 = after(e4e5, 'f1c4');
        const d4d5c4 = after(d4d5, 'c2c4');
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100 },
                        { move: 'd2d4', cp: 90 },
                        { move: 'g1f3', cp: 0 },
                    ],
                ],
                [
                    e4,
                    [
                        { move: 'e7e5', cp: -100 },
                        { move: 'c7c5', cp: -90 },
                    ],
                ],
                [d4, [{ move: 'd7d5', cp: -90 }]],
                [
                    e4e5,
                    [
                        { move: 'g1f3', cp: 100 },
                        { move: 'f1c4', cp: 95 },
                    ],
                ],
                [d4d5, [{ move: 'c2c4', cp: 90 }]],
                [e4e5Nf3, [{ move: 'b8c6', cp: -100 }]],
                [e4e5Bc4, [{ move: 'b8c6', cp: -95 }]],
                [d4d5c4, [{ move: 'g8f6', cp: -90 }]],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 4,
                multiPv: 5,
                maxAcceptedWinningChanceLoss: 0.05,
                fallbackMaxAcceptedCpLoss: 50,
                nodesPerPosition: 1234,
            },
        });

        expect(verified.diagnostics).toEqual([]);
        expect(verified.status).toBe('VERIFIED');
        expect(verified.solutionShape).toBe('MULTIPLE');
        expect(verified.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(verified.bestLineUci).toEqual([
            'e2e4',
            'e7e5',
            'g1f3',
            'b8c6',
        ]);
        expect(verified.root.branches[0]?.child).toMatchObject({
            role: 'OPPONENT',
            selectedMoveUci: 'e7e5',
            branches: [{ moveUci: 'e7e5' }],
        });
        expect(
            verified.root.branches[0]?.child.branches[0]?.child
                .acceptedMovesUci
        ).toEqual(['g1f3', 'f1c4']);
        expect(
            engine.calls.every((call) =>
                call.multiPv === 1
                    ? true
                    : call.multiPv === 5
            )
        ).toBe(true);
        expect(verified.bounds.nodesPerPosition).toBe(1234);
    });

    it('closes the MultiPV frontier when an exact returned line is already outside tolerance', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100 },
                        { move: 'd2d4', cp: 90 },
                        { move: 'g1f3', cp: -200 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 3,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.status).toBe('VERIFIED');
        expect(verified.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(verified.root.alternativesComplete).toBe(true);
        expect(verified.diagnostics.join('\n')).not.toMatch(
            /frontier remains open/
        );
    });

    it('keeps a short duplicated MultiPV frontier open while retaining the lowest slot', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100, nodes: 4_000 },
                        { move: 'e2e4', cp: 100, nodes: 10_000 },
                        { move: 'd2d4', cp: 90, nodes: 10_000 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 5,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(verified.root.branches).toHaveLength(2);
        expect(verified.root.branches).toMatchObject([
            {
                moveUci: 'e2e4',
                best: true,
                evaluation: { source: 'ENGINE', nodes: 4_000 },
            },
            {
                moveUci: 'd2d4',
                best: false,
                evaluation: { source: 'ENGINE', nodes: 10_000 },
            },
        ]);
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.status).toBe('AMBIGUOUS');
        expect(verified.diagnostics).toContain(
            'Duplicate MultiPV root move at ply 0'
        );
    });

    it('rejects an illegal unselected frontier as completeness evidence', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100 },
                        { move: 'd2d4', cp: 90 },
                        { move: 'e2e5', cp: -200 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 3,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(verified.root.branches).toHaveLength(2);
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.status).toBe('INVALID');
        expect(verified.solutionShape).toBe('OPEN');
        expect(verified.diagnostics).toContain(
            'Illegal engine move e2e5 at ply 0'
        );
    });

    it('does not promote slot two to best when malformed slot one is rejected', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'not-a-move', cp: 100 },
                        { move: 'e2e4', cp: 90 },
                        { move: 'd2d4', cp: 80 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 3,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.status).toBe('INVALID');
        expect(verified.solutionShape).toBe('OPEN');
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.diagnostics).toContain(
            'Malformed engine line in MultiPV slot 1 at ply 0'
        );
        expect(verified.diagnostics).toContain(
            'Non-contiguous MultiPV slots at ply 0'
        );
    });

    it('rejects a non-contiguous MultiPV bundle even when the adapter claims completeness', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100, multipv: 1 },
                        { move: 'd2d4', cp: 90, multipv: 3 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 3,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.status).toBe('INVALID');
        expect(verified.solutionShape).toBe('OPEN');
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.diagnostics).toContain(
            'Non-contiguous MultiPV slots at ply 0'
        );
    });

    it('keeps a short frontier open without explicit adapter proof', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e2e4', cp: 100 },
                        { move: 'd2d4', cp: 90 },
                    ],
                ],
            ]),
            'UNKNOWN'
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                maxPlies: 1,
                multiPv: 5,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(verified.status).toBe('AMBIGUOUS');
        expect(verified.solutionShape).toBe('OPEN');
        expect(verified.root.alternativesComplete).toBe(false);
    });

    it('keeps the alternative frontier open when the engine adapter cannot enumerate it', async () => {
        const root = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([[root, [{ move: 'e2e4', cp: 100 }]]]),
            false
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: { maxPlies: 1, multiPv: 5 },
        });

        expect(verified.acceptedMovesUci).toEqual(['e2e4']);
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.status).toBe('AMBIGUOUS');
        expect(verified.solutionShape).toBe('OPEN');
    });

    it('stops a legal replay on threefold repetition using source/PV history', async () => {
        const root = new Chess().fen();
        const sequence = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
        ];
        const positions = new Map<string, Line[]>();
        let fen = root;
        for (const move of sequence) {
            positions.set(fen, [{ move, cp: 0 }]);
            fen = after(fen, move);
        }
        const engine = new VerifierFixtureEngine(positions);

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: { maxPlies: 10, multiPv: 2 },
        });

        expect(verified.status).toBe('VERIFIED');
        expect(verified.bestLineUci).toEqual(sequence);
        expect(verified.stopReasons).toContain('THREEFOLD_REPETITION');
    });

    it('promotes a legal repetition-saving move omitted by standalone engine analysis', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([[root, [{ move: 'e7e6', cp: -400 }]]])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
            },
        });

        expect(verified.bestLineUci).toEqual(['f6g8']);
        expect(verified.acceptedMovesUci).toEqual(['f6g8']);
        expect(verified.root.branches[0]?.evaluation).toEqual({
            source: 'RULE',
            outcome: 'DRAW',
            reason: 'THREEFOLD_REPETITION',
        });
        expect(verified.stopReasons).toContain(
            'THREEFOLD_REPETITION'
        );
    });

    it('accepts an equivalent repetition draw for the user without displacing a slightly better engine move', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([[root, [{ move: 'e7e6', cp: 20 }]]])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.bestLineUci).toEqual(['e7e6']);
        expect(verified.acceptedMovesUci).toEqual([
            'e7e6',
            'f6g8',
        ]);
        expect(verified.root.branches).toMatchObject([
            { moveUci: 'e7e6', best: true },
            {
                moveUci: 'f6g8',
                best: false,
                evaluation: { source: 'RULE' },
            },
        ]);
    });

    it('keeps the MultiPV frontier open when an engine repetition duplicate is followed by an accepted line', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'f6g8', cp: 0 },
                        { move: 'e7e6', cp: -20 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.root.acceptedMovesUci).toEqual([
            'f6g8',
            'e7e6',
        ]);
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.status).toBe('AMBIGUOUS');
        expect(verified.diagnostics).toContain(
            'MultiPV alternative frontier remains open at ply 0'
        );
    });

    it('treats a raw losing frontier repetition line as its exact accepted draw outcome', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'e7e6', cp: 20 },
                        // Standalone FEN analysis cannot know this move
                        // reaches the third source-game occurrence.
                        { move: 'f6g8', cp: -400 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.bestLineUci).toEqual(['e7e6']);
        expect(verified.root.acceptedMovesUci).toEqual([
            'e7e6',
            'f6g8',
        ]);
        expect(verified.root.alternativesComplete).toBe(false);
        expect(verified.status).toBe('AMBIGUOUS');
    });

    it('fails safely when engine MultiPV is empty despite an exact repetition draw', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([[root, []]])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
            },
        });

        expect(verified.status).toBe('UNSTABLE');
        expect(verified.solutionShape).toBe('OPEN');
        expect(verified.acceptedMovesUci).toEqual([]);
        expect(verified.stopReasons).toContain('NO_STABLE_LINE');
        expect(verified.diagnostics).toContain(
            'No exact engine line at ply 0'
        );
    });

    it('closes a full repetition-aware MultiPV frontier when its final line is outside tolerance', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const engine = new VerifierFixtureEngine(
            new Map([
                [
                    root,
                    [
                        { move: 'f6g8', cp: 0 },
                        { move: 'e7e6', cp: -400 },
                    ],
                ],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 1,
                multiPv: 2,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.root.acceptedMovesUci).toEqual(['f6g8']);
        expect(verified.root.alternativesComplete).toBe(true);
        expect(verified.status).toBe('VERIFIED');
    });

    it('keeps genuinely better engine defense at opponent nodes instead of choosing an equivalent draw', async () => {
        const moves = [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
        ];
        const previousFens: string[] = [];
        let root = new Chess().fen();
        for (const move of moves) {
            previousFens.push(root);
            root = after(root, move);
        }
        const opponent = after(root, 'f3g1');
        const engine = new VerifierFixtureEngine(
            new Map([
                [root, [{ move: 'f3g1', cp: 0 }]],
                [opponent, [{ move: 'e7e6', cp: 20 }]],
            ])
        );

        const verified = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                previousFens,
                maxPlies: 2,
                multiPv: 2,
                fallbackMaxAcceptedCpLoss: 50,
            },
        });

        expect(verified.bestLineUci).toEqual([
            'f3g1',
            'e7e6',
        ]);
        expect(
            verified.root.branches[0]?.child.selectedMoveUci
        ).toBe('e7e6');
        expect(
            verified.root.branches[0]?.child.branches[0]
                ?.evaluation.source
        ).toBe('ENGINE');
    });

    it('adjudicates the fifty-move rule before requesting another engine line', async () => {
        const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 99 1';
        const engine = new VerifierFixtureEngine(
            new Map([[fen, [{ move: 'g1g2', cp: 500 }]]])
        );

        const verified = await verifyConditionalContinuation({
            fen,
            engine,
            options: { maxPlies: 4, multiPv: 2 },
        });

        expect(verified.bestLineUci).toEqual(['g1g2']);
        expect(verified.stopReasons).toContain('FIFTY_MOVE');
        expect(engine.calls).toHaveLength(1);
    });

    it('rejects an illegal engine PV edge', async () => {
        const fen = new Chess().fen();
        const engine = new VerifierFixtureEngine(
            new Map([[fen, [{ move: 'a1a8', cp: 100 }]]])
        );

        const verified = await verifyConditionalContinuation({
            fen,
            engine,
            options: { maxPlies: 2, multiPv: 2 },
        });

        expect(verified.status).toBe('INVALID');
        expect(verified.stopReasons).toContain('NO_STABLE_LINE');
    });

    it('uses exact tablebase WDL/DTZ without calling the engine or inventing cp', async () => {
        const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';
        const evidence: TablebaseEvidence = {
            source: 'LICHESS_SYZYGY',
            fen,
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
        const engine = new VerifierFixtureEngine(new Map());

        const verified = await verifyConditionalContinuation({
            fen,
            engine,
            tablebase,
            options: { maxPlies: 1 },
        });

        expect(verified.status).toBe('VERIFIED');
        expect(verified.acceptedMovesUci).toEqual(['g1g3']);
        expect(verified.root.branches[0]?.evaluation).toEqual({
            source: 'TABLEBASE',
            wdl: 'WIN',
            categoryAfterMove: 'loss',
            dtz: -6,
        });
        expect(verified.root.branches[0]?.evaluation).not.toHaveProperty('cp');
        expect(engine.calls).toHaveLength(0);
    });

    it('lets a history-exact repetition draw outrank a standalone tablebase loss', async () => {
        const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';
        const repetitionAfter = after(fen, 'g1g2');
        const evidence: TablebaseEvidence = {
            source: 'LICHESS_SYZYGY',
            fen,
            pieceCount: 3,
            wdl: 'LOSS',
            category: 'loss',
            terminal: {
                checkmate: false,
                stalemate: false,
                insufficientMaterial: false,
            },
            moves: [
                {
                    uci: 'g1g3',
                    wdl: 'LOSS',
                    categoryAfterMove: 'win',
                },
            ],
            fetchedAt: '2026-01-01T00:00:00.000Z',
        };
        const engine = new VerifierFixtureEngine(new Map());

        const verified = await verifyConditionalContinuation({
            fen,
            engine,
            tablebase: { probe: async () => evidence },
            options: {
                maxPlies: 1,
                previousFens: [
                    repetitionAfter,
                    repetitionAfter,
                ],
            },
        });

        expect(verified.bestLineUci).toEqual(['g1g2']);
        expect(verified.root.branches[0]?.evaluation).toEqual({
            source: 'RULE',
            outcome: 'DRAW',
            reason: 'THREEFOLD_REPETITION',
        });
        expect(engine.calls).toHaveLength(0);
    });

    it.each([
        {
            label: 'checkmate',
            fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',
            move: 'f7f8',
            reason: 'CHECKMATE',
        },
        {
            label: 'stalemate',
            fen: 'k7/2Q5/2K5/8/8/8/8/8 w - - 0 1',
            move: 'c7b6',
            reason: 'STALEMATE',
        },
        {
            label: 'insufficient material',
            fen: '7k/8/8/8/8/8/8/rK6 w - - 0 1',
            move: 'b1a1',
            reason: 'INSUFFICIENT_MATERIAL',
        },
    ] as const)(
        'stops immediately after a legal move reaches $label',
        async ({ fen, move, reason }) => {
            const engine = new VerifierFixtureEngine(
                new Map([[fen, [{ move, cp: 100 }]]])
            );

            const verified = await verifyConditionalContinuation({
                fen,
                engine,
                options: { maxPlies: 4, multiPv: 2 },
            });

            expect(verified.status).toBe('VERIFIED');
            expect(verified.bestLineUci).toEqual([move]);
            expect(verified.stopReasons).toContain(reason);
            expect(engine.calls).toHaveLength(1);
        }
    );
});
