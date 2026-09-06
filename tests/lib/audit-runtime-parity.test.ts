import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { Chess } from 'chess.js';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { ServerStockfishClient, parseUciInfoLine } from '@/lib/analysis/serverStockfishClient';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';
import { isStructurallyCompleteMultiPvBundle, resolveEngineSearchContext, normalizeRestrictedRootMoves, type MultiPvLine } from '@/lib/analysis/stockfishClient';

// Regressions converted from the isolated audit reproductions.
const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup.splice(0).forEach((fn) => fn());
    vi.unstubAllGlobals();
});

function browserClient() {
    const searches: unknown[] = [];
    class FakeWorker {
        onmessage?: (event: { data: unknown }) => void;
        onerror?: (event: unknown) => void;
        terminate() {}
        postMessage(message: { type: string; id: string; fen: string }) {
            if (message.type !== 'start') return;
            searches.push(message);
            queueMicrotask(() => this.onmessage?.({ data: {
                type: 'done', id: message.id, bestMoveUci: 'e2e4',
                final: { fen: message.fen, lines: [{
                    multipv: 1, pvUci: ['e2e4'],
                    score: { type: 'cp', value: searches.length * 10 },
                }] },
            } }));
        }
    }
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('Worker', FakeWorker);
    const client = new StockfishClient();
    cleanup.push(() => client.terminate());
    return { client, searches };
}

function serverRuntime() {
    const commands: string[] = [];
    let searches = 0;
    const runtime: ServerStockfishRuntime = {
        sendCommand(command) {
            commands.push(command);
            queueMicrotask(() => {
                if (command === 'uci') runtime.listener?.('uciok');
                if (command === 'isready') runtime.listener?.('readyok');
                if (command.startsWith('go ')) {
                    searches++;
                    runtime.listener?.(`info depth 8 multipv 1 score cp ${searches * 10} nodes 100000 pv e2e4`);
                    runtime.listener?.('bestmove e2e4');
                }
            });
        },
        terminate() {},
    };
    return { runtime, commands };
}

describe('audit: browser/server search evidence parity', () => {
    it('uses the same default budget and root width in both adapters', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const server = new ServerStockfishClient({ runtimeFactory: async () => mocked.runtime });
        cleanup.push(() => server.terminate());
        for (const engine of [browser.client, server]) {
            const result = await engine.analyzeMultiPv({ fen });
            expect(result.alternativesComplete).toBe(true);
            expect(result.searchEvidence?.request).toMatchObject({ multiPv: 1, limits: { nodes: 100_000 } });
        }
    });

    it('keeps upper/lower bounds separate from exact lines on both protocols', () => {
        const context = createContext({ self: {}, setTimeout, clearTimeout, URL });
        runInContext(readFileSync('public/vendor/stockfish/backranq-engine.worker.js', 'utf8') + '\nglobalThis.auditParse = parseInfoLine;', context);
        const parseBrowser = context.auditParse as typeof parseUciInfoLine;
        for (const parse of [parseBrowser, parseUciInfoLine]) {
            for (const [uciBound, expected] of [['upperbound', 'UPPER'], ['lowerbound', 'LOWER']]) {
                const result = parse(`info depth 12 multipv 1 score cp -110 ${uciBound} nodes 30000 pv e2e4`);
                expect(result.score).toBeNull();
                expect(result.boundedScore).toEqual({ type: 'cp', value: -110 });
                expect(result.bound).toBe(expected);
            }
        }
    });

    it('rejects a returned move outside the exact requested scope', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const server = new ServerStockfishClient({ runtimeFactory: async () => mocked.runtime });
        cleanup.push(() => server.terminate());
        for (const engine of [browser.client, server]) {
            await expect(engine.analyzeMultiPv({ fen, nodes: 100_000, multiPv: 1, rootMoves: ['d2d4'] })).rejects.toThrow(/PV/);
        }
    });

    it('both adapters explicitly reuse one evidence ID and fresh confirmation gets a new ID', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const server = new ServerStockfishClient({ runtimeFactory: async () => mocked.runtime });
        cleanup.push(() => server.terminate());
        for (const engine of [browser.client, server]) {
            const first = await engine.analyzeMultiPv({ fen, nodes: 100_000, multiPv: 1, purpose: 'SCAN', reuse: 'REUSE_ALLOWED' });
            const reused = await engine.analyzeMultiPv({ fen, nodes: 100_000, multiPv: 1, purpose: 'SCAN', reuse: 'REUSE_ALLOWED' });
            const fresh = await engine.analyzeMultiPv({ fen, nodes: 100_000, multiPv: 1, purpose: 'CONFIRM', reuse: 'FRESH_REQUIRED' });
            expect(reused.searchEvidence).toMatchObject({ id: first.searchEvidence!.id, reused: true, request: { purpose: 'SCAN' } });
            expect(fresh.searchEvidence!.id).not.toBe(first.searchEvidence!.id);
            expect(fresh.searchEvidence).toMatchObject({ reused: false, request: { purpose: 'CONFIRM' } });
        }
        expect(browser.searches).toHaveLength(2);
        expect(mocked.commands.filter((command) => command.startsWith('go '))).toHaveLength(2);
    });

    it('enumerates full legal root scope and preserves a legal replay history', async () => {
        const chess = new Chess();
        const roots = chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}`);
        expect(normalizeRestrictedRootMoves(roots, fen)).toHaveLength(20);
        expect(() => normalizeRestrictedRootMoves(['e2e5'], fen)).toThrow(/legal/);
        const previousFens = [chess.fen()];
        chess.move('e4'); previousFens.push(chess.fen());
        chess.move('e5'); previousFens.push(chess.fen());
        chess.move('Nf3');
        expect(resolveEngineSearchContext({ fen: chess.fen(), previousFens }).positionCommand).toBe(`position fen ${fen} moves e2e4 e7e5 g1f3`);
        expect(() => resolveEngineSearchContext({ fen, previousFens: [chess.fen()] })).toThrow(/legally replay/);
        const prefixFen = chess.fen();
        chess.move('Nc6');
        expect(resolveEngineSearchContext({ fen: chess.fen(), previousFens: [...previousFens, prefixFen] }).positionCommand).toBe(`position fen ${fen} moves e2e4 e7e5 g1f3 b8c6`);
        expect(() => resolveEngineSearchContext({ fen, previousFens: [...previousFens, prefixFen] })).toThrow(/legally replay/);

        const mocked = serverRuntime();
        const server = new ServerStockfishClient({ runtimeFactory: async () => mocked.runtime });
        cleanup.push(() => server.terminate());
        const result = await server.analyzeMultiPv({ fen, nodes: 100_000, multiPv: 1, rootMoves: roots });
        expect(mocked.commands).toContain(`go nodes 100000 searchmoves ${roots.sort().join(' ')}`);
        expect(result.searchEvidence!.request.rootMoves).toEqual(roots);
    });

    it('only exact legal scope exhaustion completes a short MultiPV bundle', () => {
        const position = '7k/8/5Q2/8/6K1/8/8/8 b - - 0 1';
        const scope = resolveEngineSearchContext({ fen: position }).legalRootMoves;
        const lines: MultiPvLine[] = scope.map((move, index) => ({ multipv: index + 1, pvUci: [move], score: { type: 'mate', value: -4 } }));
        expect(scope).toHaveLength(2);
        expect(isStructurallyCompleteMultiPvBundle(lines, 5, scope)).toBe(true);
        expect(isStructurallyCompleteMultiPvBundle(lines.slice(0, 1), 5, scope)).toBe(false);
        expect(isStructurallyCompleteMultiPvBundle([{ ...lines[0], pvUci: ['h8g7'] }, lines[1]], 5, scope)).toBe(false);
    });

    it('resolves checkmate and stalemate exactly without starting UCI search', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const factory = vi.fn(async () => mocked.runtime);
        const server = new ServerStockfishClient({ runtimeFactory: factory });
        cleanup.push(() => server.terminate());
        for (const engine of [browser.client, server]) {
            const mate = await engine.evalPosition({ fen: '5Q1k/8/6K1/8/8/8/8/8 b - - 1 1', nodes: 100_000 });
            expect(mate).toMatchObject({ score: { type: 'mate', value: 0 }, terminal: { kind: 'CHECKMATE', outcome: 'LOSS' }, searchEvidence: { source: 'RULE', reported: { nodes: 0 } } });
            const draw = await engine.evalPosition({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', nodes: 100_000 });
            expect(draw).toMatchObject({ score: { type: 'cp', value: 0 }, terminal: { kind: 'STALEMATE', outcome: 'DRAW' } });
        }
        expect(browser.searches).toHaveLength(0);
        expect(factory).not.toHaveBeenCalled();
    });

    it('shares mandatory 75-move and fivefold results while retaining claimable draws as decisions', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const factory = vi.fn(async () => mocked.runtime);
        const server = new ServerStockfishClient({ runtimeFactory: factory });
        cleanup.push(() => server.terminate());
        const board = new Chess();
        const history: string[] = [];
        for (let cycle = 0; cycle < 4; cycle++) {
            for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) {
                history.push(board.fen()); board.move(move);
            }
        }
        for (const engine of [browser.client, server]) {
            expect(await engine.evalPosition({ fen: '7k/8/8/8/8/8/8/KR6 w - - 150 76' })).toMatchObject({ terminal: { kind: 'SEVENTY_FIVE_MOVE_RULE', outcome: 'DRAW' }, searchEvidence: { source: 'RULE' } });
            expect(await engine.evalPosition({ fen: board.fen(), previousFens: history })).toMatchObject({ terminal: { kind: 'FIVEFOLD_REPETITION', outcome: 'DRAW' }, searchEvidence: { source: 'RULE' } });
        }
        expect(resolveEngineSearchContext({ fen: '7k/8/8/8/8/8/8/KR6 w - - 100 51' }).terminal).toBeUndefined();
        expect(resolveEngineSearchContext({ fen: history[8], previousFens: history.slice(0, 8) }).terminal).toBeUndefined();
        expect(browser.searches).toHaveLength(0);
        expect(factory).not.toHaveBeenCalled();
    });

    it('browser keeps an earlier valid bucket when the newest bucket duplicates a root', () => {
        // Exact roots/scores from the actual100k initial-position run. Stockfish
        // updated slot5 within depth10 after previously publishing all slots.
        const makeLines = (depth: number, roots: string[], scores: number[]) => new Map(roots.map((root, index) => [index + 1, {
            multipv: index + 1, pvUci: [root], score: { type: 'cp', value: scores[index] }, depth,
        } satisfies MultiPvLine]));
        const prior = makeLines(9, ['e2e4', 'd2d4', 'g1f3', 'e2e3', 'c2c4'], [35, 25, 19, 18, 17]);
        const latest = makeLines(10, ['e2e4', 'd2d4', 'e2e3', 'c2c4', 'e2e3'], [38, 23, 20, 19, 20]);
        const context = createContext({ self: {}, setTimeout, clearTimeout, URL });
        const source = readFileSync('public/vendor/stockfish/backranq-engine.worker.js', 'utf8');
        runInContext(source + '\nglobalThis.auditBuildSnapshot = buildSnapshot;', context);
        const buildSnapshot = context.auditBuildSnapshot as (job: unknown) => { depth: number; lines: MultiPvLine[] };
        const selected = buildSnapshot({ fen, multiPv: 5, linesByDepth: new Map([[9, prior], [10, latest]]) });
        expect(selected.depth).toBe(9);
        expect(isStructurallyCompleteMultiPvBundle(selected.lines, 5)).toBe(true);
        expect(isStructurallyCompleteMultiPvBundle([...prior.values()], 5)).toBe(true);
    });

    it('both adapters issue fresh searches by default', async () => {
        const browser = browserClient();
        const mocked = serverRuntime();
        const server = new ServerStockfishClient({ runtimeFactory: async () => mocked.runtime });
        cleanup.push(() => server.terminate());
        const request = { fen, nodes: 200_000, multiPv: 1 };
        const browserFirst = await browser.client.analyzeMultiPv(request);
        const browserConfirmation = await browser.client.analyzeMultiPv(request);
        const serverFirst = await server.analyzeMultiPv(request);
        const serverConfirmation = await server.analyzeMultiPv(request);
        expect(browser.searches).toHaveLength(2);
        expect(browserConfirmation.searchEvidence?.id).not.toBe(browserFirst.searchEvidence?.id);
        expect(mocked.commands.filter((c) => c.startsWith('go '))).toHaveLength(2);
        expect(serverConfirmation.lines[0].score).not.toEqual(serverFirst.lines[0].score);
    });

    it('browser rejects empty nonterminal exact-PV results without caching them', async () => {
        const browser = browserClient();
        // Exercise the public bridge response path without an engine search.
        const worker = (browser.client as unknown as { worker: { postMessage: (m: { id: string; fen: string }) => void; onmessage: (e: { data: unknown }) => void } }).worker;
        worker.postMessage = (message) => queueMicrotask(() => worker.onmessage({ data: {
            type: 'done', id: message.id, bestMoveUci: 'e2e4',
            final: { fen: message.fen, lines: [] },
        } }));
        await expect(browser.client.evalPosition({ fen, nodes: 100_000 })).rejects.toThrow('no valid exact PV');
        await expect(browser.client.evalPosition({ fen, nodes: 100_000, reuse: 'REUSE_ALLOWED' })).rejects.toThrow('no valid exact PV');
    });

    it('server cancelAll during startup rejects immediately and never starts a search', async () => {
        const mocked = serverRuntime();
        let resolveRuntime!: (runtime: ServerStockfishRuntime) => void;
        const startup = new Promise<ServerStockfishRuntime>((resolve) => { resolveRuntime = resolve; });
        const factory = vi.fn(() => startup);
        const server = new ServerStockfishClient({ runtimeFactory: factory });
        cleanup.push(() => server.terminate());
        const pending = server.evalPosition({ fen, nodes: 100_000 });
        await Promise.resolve();
        expect(factory).toHaveBeenCalledOnce();
        server.cancelAll();
        resolveRuntime(mocked.runtime);
        await expect(pending).rejects.toThrow(/cancelled/);
        await server.getIdentity();
        await Promise.resolve();
        expect(mocked.commands).not.toContain('go nodes 100000');
    });
});
