import { Chess } from 'chess.js';
import { createAnalysisSnapshot, createSearchEvidence, resolveEngineSearchContext, terminalEngineResult,
    type AnalysisLimit, type EvalResult, type MultiPvResult, type Score, type StockfishEngine, type EngineWdl } from '@/lib/analysis/stockfishClient';

export type ScriptLine = { move: string; cp?: number; mate?: number; pv?: string[]; wdl?: EngineWdl };
export type ScriptRequest = AnalysisLimit & { fen: string; multiPv: number; method: 'eval' | 'multi' };
/** Explicit synthetic complete iterations; no application code fabricates snapshots. */
export class ScriptedExtractionEngine implements StockfishEngine {
    readonly requests: ScriptRequest[] = [];
    readonly positions = new Map<string, ScriptLine[]>();
    snapshotDepths = [10, 11, 12];
    onRequest?: (request: ScriptRequest) => void;
    transformIteration?: (request: ScriptRequest, lines: ScriptLine[], iteration: number) => ScriptLine[];
    private sequence = 0;
    set(fen: string, lines: ScriptLine[]): this { this.positions.set(fen, lines); return this; }
    private run(opts: AnalysisLimit & {fen: string; multiPv?: number}, method: 'eval' | 'multi'): MultiPvResult {
        const request: ScriptRequest = { ...opts, multiPv: method === 'eval' ? 1 : opts.multiPv ?? 1, method };
        this.requests.push(request); this.onRequest?.(request);
        const context = resolveEngineSearchContext(opts); const id = `scripted-search-${++this.sequence}`;
        const identity = { artifactId: 'fixture-artifact', name: 'Scripted test engine', version: '4', source: 'test-fixture', options: { UCI_ShowWDL: this.positions.get(opts.fen)?.some(l => l.wdl) ?? false } };
        const count = opts.nodes ?? 100; const reported = { nodes: count, timeMs: 1 };
        const searchEvidence = createSearchEvidence(id, identity, context, request, reported, 'fixture-session');
        const terminal = terminalEngineResult(context, searchEvidence); if (terminal) return terminal;
        const scope = context.rootMoves ?? context.legalRootMoves;
        const script = this.positions.get(opts.fen) ?? [{ move: scope[0], cp: 0 }];
        const selected = script.filter(line => scope.includes(line.move)).slice(0, Math.min(request.multiPv, scope.length));
        for (const move of scope) {
            if (selected.length >= Math.min(request.multiPv, scope.length)) break;
            if (!selected.some(line => line.move === move)) selected.push({ move, cp: this.positions.has(opts.fen) ? -400 : 0 });
        }
        const snapshots = this.snapshotDepths.flatMap((depth, index) => {
            const scripted = this.transformIteration?.(request, structuredClone(selected), index) ?? selected;
            const lines = scripted.map((line, i) => ({ multipv: i + 1, score: line.mate === undefined ? { type: 'cp', value: line.cp ?? 0 } as Score : { type: 'mate', value: line.mate } as Score,
                pvUci: line.pv ?? [line.move], ...(line.wdl ? { wdl: line.wdl } : {}), depth,
                nodes: Math.floor(count * (index + 1) / this.snapshotDepths.length), timeMs: 1 }));
            const snapshot = createAnalysisSnapshot(id, index, identity, context, request, lines, 'fixture-session');
            if (snapshot) opts.onSnapshot?.(snapshot);
            return snapshot ? [snapshot] : [];
        });
        const lines = snapshots.at(-1)?.lines ?? selected.map((line, index) => ({ multipv: index + 1, score: { type: 'cp', value: line.cp ?? 0 } as Score, pvUci: line.pv ?? [line.move] }));
        return { fen: opts.fen, bestMoveUci: lines[0]?.pvUci[0] ?? '', lines, alternativesComplete: snapshots.length > 0, identity, searchEvidence, snapshots };
    }
    async evalPosition(opts: AnalysisLimit & {fen: string}): Promise<EvalResult> {
        const result = this.run(opts, 'eval'); const best = result.lines[0];
        return { fen: result.fen, bestMoveUci: result.bestMoveUci, pvUci: best?.pvUci ?? [], score: best?.score ?? null, wdl: best?.wdl, searchEvidence: result.searchEvidence, snapshots: result.snapshots, terminal: result.terminal };
    }
    async analyzeMultiPv(opts: AnalysisLimit & {fen: string; multiPv?: number}): Promise<MultiPvResult> { return this.run(opts, 'multi'); }
}
export function afterFixtureMove(fen: string, move: string): string {
    const board = new Chess(fen); board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); return board.fen();
}
