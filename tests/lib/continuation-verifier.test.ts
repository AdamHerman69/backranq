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
        alternativesComplete: boolean | 'UNKNOWN' = true,
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
        opts: AnalysisLimit & { fen: string; multiPv?: number },
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
                      alternativesComplete: this.alternativesComplete,
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

describe('bounded independent continuation and coverage', () => {
    const root = new Chess().fen();
    const seed = (items: Line[], fen = root): MultiPvResult => ({
        fen,
        bestMoveUci: items[0]?.move ?? '',
        lines: items.map((item, index) => ({
            multipv: item.multipv ?? index + 1,
            pvUci: [item.move],
            score: { type: 'cp', value: item.cp },
        })),
    });
    const seeded = (items: Line[], options: Record<string, unknown> = {}) =>
        verifyConditionalContinuation({
            fen: root,
            engine: new VerifierFixtureEngine(new Map()),
            options: { seed: seed(items), maxPlies: 1, ...options },
        });

    it('retains seeded individual answers without a duplicate root search or blanket rejection', async () => {
        const result = await seeded([
            { move: 'e2e4', cp: 100 },
            { move: 'd2d4', cp: 90 },
            { move: 'g1f3', cp: -200 },
        ]);
        expect(result.status).toBe('VERIFIED');
        expect(result.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(result.answerCoverage).toMatchObject({
            status: 'PARTIAL',
            assessedMovesUci: ['d2d4', 'e2e4', 'g1f3'],
            coveredMovesUci: [],
        });
        expect(result.root.alternativesComplete).toBe(false);
        expect(result.bounds.positionsVisited).toBe(0);
    });
    it('keeps unknown legal moves outside certified rejection scope even after a large exact score gap', async () => {
        const result = await seeded([
            { move: 'e2e4', cp: 100 },
            { move: 'd2d4', cp: -900 },
        ]);
        expect(result.answerCoverage.legalMovesUci).toHaveLength(20);
        expect(result.answerCoverage.coveredMovesUci).toEqual([]);
        expect(result.answerCoverage.assessedMovesUci).not.toContain('g1f3');
    });
    it('does not promote slot two when the best slot is illegal', async () => {
        const result = await seeded([
            { move: 'e2e5', cp: 100 },
            { move: 'd2d4', cp: 90 },
        ]);
        expect(result.status).toBe('UNSTABLE');
        expect(result.acceptedMovesUci).toEqual([]);
    });
    it('excludes malformed secondary lines while retaining independently legal answers', async () => {
        const result = await seeded([
            { move: 'e2e4', cp: 100 },
            { move: 'e2e4', cp: 100 },
            { move: 'd2d5', cp: 90 },
            { move: 'g1f3', cp: 80 },
        ]);
        expect(result.status).toBe('VERIFIED');
        expect(result.acceptedMovesUci).toEqual(['e2e4', 'g1f3']);
        expect(result.answerCoverage.assessedMovesUci).toEqual([
            'e2e4',
            'g1f3',
        ]);
    });
    it('conserves common membership and uncertain tiers across standalone observations', async () => {
        let pass = 0;
        const engine: StockfishEngine = {
            evalPosition: async () => {
                throw Error('unused');
            },
            analyzeMultiPv: async () =>
                seed(
                    ++pass === 1
                        ? [
                              { move: 'e2e4', cp: 100 },
                              { move: 'd2d4', cp: 60 },
                              { move: 'g1f3', cp: 0 },
                          ]
                        : [
                              { move: 'e2e4', cp: 100 },
                              { move: 'd2d4', cp: 45 },
                              { move: 'g1f3', cp: -10 },
                          ],
                ),
        };
        const result = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: { maxPlies: 1 },
        });
        expect(result.status).toBe('VERIFIED');
        expect(result.acceptedMovesUci).toEqual(['e2e4', 'd2d4']);
        expect(
            result.root.moveEvaluations?.find((item) => item.moveUci === 'd2d4')
                ?.tierStable,
        ).toBe(false);
    });
    it('never makes a malformed ranking into a verified root', async () => {
        const result = await seeded([
            { move: 'e2e4', cp: 100 },
            { move: 'd2d4', cp: 40 },
            { move: 'g1f3', cp: 80 },
        ]);
        expect(result.status).toBe('UNSTABLE');
    });
    it('does not invalidate a confirmed root when optional opponent explanation fails', async () => {
        const result = await seeded([{ move: 'e2e4', cp: 100 }], {
            maxPlies: 2,
        });
        expect(result.status).toBe('VERIFIED');
        expect(result.continuation.gradedContinuationReady).toBe(false);
        expect(result.diagnostics).toContain(
            'Optional preferred continuation unavailable; root retained',
        );
    });
    it('only enriches the preferred answer and carries exact history into a further graded decision', async () => {
        const e4 = after(root, 'e2e4');
        const e5 = after(e4, 'e7e5');
        const engine = new VerifierFixtureEngine(
            new Map([
                [e4, [{ move: 'e7e5', cp: 0 }]],
                [
                    e5,
                    [
                        { move: 'g1f3', cp: 100 },
                        { move: 'f1c4', cp: 80 },
                    ],
                ],
            ]),
        );
        const result = await verifyConditionalContinuation({
            fen: root,
            engine,
            options: {
                seed: seed([
                    { move: 'e2e4', cp: 100 },
                    { move: 'd2d4', cp: 90 },
                ]),
                maxPlies: 3,
            },
        });
        expect(result.continuation.status).toBe('GRADED_BRANCHES_READY');
        const nested = result.root.branches[0]!.child.branches[0]!.child;
        expect(nested).toMatchObject({
            role: 'USER',
            ply: 2,
            positionHistory: [root, e4],
            acceptedMovesUci: ['g1f3', 'f1c4'],
            answerCoverage: { status: 'PARTIAL' },
        });
        expect(result.root.branches[1]!.child.role).toBe('TERMINAL');
        expect(
            engine.calls.some((call) => call.fen === after(root, 'd2d4')),
        ).toBe(false);
    });
    it('marks all legal assessed only when the exact enumerated legal list is indexed', async () => {
        const fen = '7k/8/5Q2/8/6K1/8/8/8 b - - 0 1';
        const legal = new Chess(fen)
            .moves({ verbose: true })
            .map((move) => move.lan);
        const result = await verifyConditionalContinuation({
            fen,
            engine: new VerifierFixtureEngine(new Map()),
            options: {
                seed: seed(
                    legal.map((move) => ({ move, cp: -100 })),
                    fen,
                ),
                maxPlies: 1,
            },
        });
        expect(result.answerCoverage.status).toBe('ALL_LEGAL_ASSESSED');
        expect(result.answerCoverage.assessedMovesUci).toEqual(legal.sort());
    });
    it('rejects an already checkmated root without an engine call', async () => {
        const fen = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
        const engine = new VerifierFixtureEngine(new Map());
        const result = await verifyConditionalContinuation({ fen, engine });
        expect(result.status).toBe('INVALID');
        expect(result.stopReasons).toEqual(['CHECKMATE']);
        expect(engine.calls).toEqual([]);
    });
    it('stops a mated continuation without fabricating a further PV', async () => {
        const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
        const result = await verifyConditionalContinuation({
            fen,
            engine: new VerifierFixtureEngine(new Map()),
            options: {
                seed: seed([{ move: 'f7f8', cp: 100 }], fen),
                maxPlies: 4,
            },
        });
        expect(result.status).toBe('VERIFIED');
        expect(result.stopReasons).toContain('CHECKMATE');
        expect(result.bestLineUci).toEqual(['f7f8']);
    });
    it('never treats UNKNOWN tablebase moves as DRAW or complete coverage', async () => {
        const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';
        const evidence: TablebaseEvidence = {
            source: 'LICHESS_SYZYGY',
            fen,
            pieceCount: 3,
            wdl: 'WIN',
            category: 'win',
            terminal: {
                checkmate: false,
                stalemate: false,
                insufficientMaterial: false,
            },
            moves: [
                { uci: 'g1g3', wdl: 'WIN', categoryAfterMove: 'loss' },
                { uci: 'g1g2', wdl: 'UNKNOWN', categoryAfterMove: 'unknown' },
            ],
            fetchedAt: '2026-01-01T00:00:00Z',
        };
        const tablebase: TablebaseProvider = { probe: async () => evidence };
        const result = await verifyConditionalContinuation({
            fen,
            engine: new VerifierFixtureEngine(new Map()),
            tablebase,
            options: { maxPlies: 1 },
        });
        expect(result.acceptedMovesUci).toEqual(['g1g3']);
        expect(result.answerCoverage.status).toBe('PARTIAL');
        expect(result.answerCoverage.assessedMovesUci).not.toContain('g1g2');
    });
    it('does not certify a known losing move when the tablebase root says a draw exists elsewhere', async () => {
        const fen = '8/8/8/8/8/2k5/4K3/6R1 w - - 0 1';
        const tablebase: TablebaseProvider = {
            probe: async () => ({
                source: 'LICHESS_SYZYGY',
                fen,
                pieceCount: 3,
                wdl: 'DRAW',
                category: 'draw',
                terminal: {
                    checkmate: false,
                    stalemate: false,
                    insufficientMaterial: false,
                },
                moves: [{ uci: 'g1g2', wdl: 'LOSS', categoryAfterMove: 'win' }],
                fetchedAt: '2026-01-01T00:00:00Z',
            }),
        };
        const result = await verifyConditionalContinuation({
            fen,
            engine: new VerifierFixtureEngine(new Map()),
            tablebase,
            options: { maxPlies: 1 },
        });
        expect(result.status).toBe('UNSTABLE');
        expect(result.acceptedMovesUci).toEqual([]);
    });
});

it('stops a stalemated continuation without requesting a further search', async () => {
    const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
    const next = after(fen, 'f7e6');
    expect(new Chess(next).isStalemate()).toBe(true);
    const engine = new VerifierFixtureEngine(new Map());
    const result = await verifyConditionalContinuation({
        fen,
        engine,
        options: {
            seed: {
                fen,
                bestMoveUci: 'f7e6',
                lines: [
                    {
                        multipv: 1,
                        pvUci: ['f7e6'],
                        score: { type: 'cp', value: 0 },
                    },
                ],
            },
            maxPlies: 4,
        },
    });
    expect(result.status).toBe('VERIFIED');
    expect(result.stopReasons).toContain('STALEMATE');
    expect(engine.calls).toEqual([]);
});
