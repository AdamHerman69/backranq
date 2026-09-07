import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { StockfishClient, type AnalysisSnapshot, type StockfishEngine } from '@/lib/analysis/stockfishClient';
import { assessMove } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, practiceContextId, type ComparisonFrame } from '@/lib/training/practiceContract';
import { practiceEngineFingerprint, practiceEvidenceFromSnapshots } from '@/lib/analysis/practiceEvidence';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';

const fen = new Chess().fen();
const transcript = [4, 6, 8, 10].flatMap((depth) => [
    `info depth ${depth} multipv 1 score cp 30 nodes ${depth * 100} time ${depth} pv e2e4 e7e5`,
    `info depth ${depth} multipv 2 score cp 20 nodes ${depth * 100 + 10} time ${depth} pv d2d4 d7d5`,
]);
transcript.push('info depth 12 multipv 1 score cp 500 lowerbound nodes 1400 pv e2e4',
    'info depth 13 multipv 2 score cp 10 nodes 1500 pv d2d4',
    'info multipv 1 score cp 999 nodes 1600 pv e2e4', 'bestmove e2e4');
const clients: Array<{ terminate(): void }> = [];
const withMatureNodes = (lines: string[]) => lines.map(line => line.replace(/nodes (\d+)/, (_, nodes: string) => `nodes ${100_000 + Number(nodes)}`));
afterEach(() => { clients.splice(0).forEach((client) => client.terminate()); vi.unstubAllGlobals(); });

function server(lines = transcript) {
    const commands: string[] = [];
    const runtime: ServerStockfishRuntime = {
        sendCommand(command) {
            commands.push(command);
            queueMicrotask(() => {
                if (command === 'uci') runtime.listener?.('uciok');
                if (command === 'isready') runtime.listener?.('readyok');
                if (command.startsWith('go ')) lines.forEach((line) => runtime.listener?.(line));
            });
        }, terminate() {},
    };
    const client = new ServerStockfishClient({ runtimeFactory: async () => runtime });
    clients.push(client);
    return { client, commands };
}

function browser(lines = transcript) {
    const commands: string[] = [];
    class NestedWorker {
        onmessage: ((event: { data: string }) => void) | null = null;
        postMessage(command: string) {
            commands.push(command);
            queueMicrotask(() => {
                if (command === 'uci') this.onmessage?.({ data: 'uciok' });
                if (command === 'isready') this.onmessage?.({ data: 'readyok' });
                if (command.startsWith('go ')) lines.forEach((data) => this.onmessage?.({ data }));
            });
        }
        terminate() {}
    }
    class OuterWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        self = { location: { href: 'https://example.test/vendor/stockfish/backranq-engine.worker.js' }, onmessage: null as ((event: { data: unknown }) => void) | null };
        constructor() {
            runInNewContext(readFileSync('public/vendor/stockfish/backranq-engine.worker.js', 'utf8'), {
                self: this.self, Worker: NestedWorker, URL, setTimeout, clearTimeout,
                postMessage: (data: unknown) => queueMicrotask(() => this.onmessage?.({ data })),
            });
        }
        postMessage(data: unknown) { this.self.onmessage?.({ data }); }
        terminate() {}
    }
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('Worker', OuterWorker);
    const client = new StockfishClient();
    clients.push(client);
    return { client, commands };
}

// A real scripted UCI search supplies the separate focused proof. Its search
// ID, completion and 400k reported nodes travel through the adapter under test.
async function referenceProbe(client: StockfishEngine, lines: string[]) {
    const saved = [...lines];
    lines.splice(0, lines.length, ...[4, 6, 8].map((depth, index) =>
        `info depth ${depth} multipv 1 score cp 30 nodes ${[100_000, 200_000, 400_000][index]} time ${depth} pv e2e4 e7e5`), 'bestmove e2e4');
    const result = await client.analyzeMultiPv({ fen, rootMoves: ['e2e4'], multiPv: 1, nodes: 400_000, purpose: 'VERIFY_REFERENCE', reuse: 'FRESH_REQUIRED' });
    lines.splice(0, lines.length, ...saved);
    expect(result.searchEvidence?.reported.nodes).toBe(400_000);
    const canonical = practiceEvidenceFromSnapshots(result.snapshots!, 'WHITE', [result.searchEvidence!]);
    expect(canonical.searches[result.searchEvidence!.id].completion).toBe('COMPLETED');
    return result;
}

describe.each([['server', server], ['browser actual bridge', browser]] as const)('%s physical snapshots', (_, setup) => {
    it('emits exact complete iterations, retains last three, and does not turn a cache hit into convergence', async () => {
        const { client, commands } = setup();
        const snapshots: AnalysisSnapshot[] = [];
        const first = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 2000,
            onSnapshot: (snapshot) => snapshots.push(snapshot) });
        expect(snapshots.filter(snapshot => snapshot.bundleComplete).map((snapshot) => snapshot.depth)).toEqual([4, 6, 8, 10]);
        expect(first.snapshots?.filter(snapshot => snapshot.bundleComplete).map((snapshot) => snapshot.depth)).toEqual([6, 8, 10]);
        expect(first.snapshots?.filter(snapshot => !snapshot.bundleComplete)).toHaveLength(1);
        expect(first.lines.map((line) => line.depth)).toEqual([10, 10]);
        expect(first.searchEvidence?.sessionId).toBeTruthy();
        expect(first.snapshots?.every((snapshot) => snapshot.searchEvidence.sessionId === first.searchEvidence?.sessionId)).toBe(true);
        expect(first.snapshots?.every((snapshot) => snapshot.searchId === first.searchEvidence?.id)).toBe(true);
        const callback = vi.fn();
        const reused = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 2000, reuse: 'REUSE_ALLOWED', onSnapshot: callback });
        expect(reused.snapshots).toEqual(first.snapshots);
        expect(reused.searchEvidence?.reused).toBe(true);
        expect(callback).not.toHaveBeenCalled();
        expect(commands.filter((command) => command.startsWith('go '))).toHaveLength(1);
        const second = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 2000, reuse: 'FRESH_REQUIRED' });
        expect(second.searchEvidence?.id).not.toBe(first.searchEvidence?.id);
        expect(second.searchEvidence?.sessionId).toBe(first.searchEvidence?.sessionId);
        expect(commands.filter((command) => command === 'ucinewgame')).toHaveLength(1);
    });
    it('retains changed same-depth complete scores as new physical observations and deduplicates repeats', async () => {
        const refutation = 'info depth 10 multipv 2 score cp -200 nodes 1600 time 16 pv d2d4 d7d5';
        const lines = withMatureNodes([...transcript.slice(0, 8), 'bestmove e2e4']);
        const { client } = setup(lines);
        const probe = await referenceProbe(client, lines);
        const prior = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 200_000, reuse: 'FRESH_REQUIRED' });
        lines.splice(0, lines.length, ...withMatureNodes([...transcript.slice(0, 8), refutation, refutation, 'bestmove e2e4']));
        const snapshots: AnalysisSnapshot[] = [];
        const result = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 200_000, reuse: 'FRESH_REQUIRED', onSnapshot: value => snapshots.push(value) });
        expect(result.searchEvidence?.id).not.toBe(prior.searchEvidence?.id);
        expect(snapshots.map(value => value.depth)).toEqual([4, 6, 8, 10, 10]);
        expect(new Set(snapshots.map(value => value.id)).size).toBe(5);
        expect(result.snapshots?.map(value => value.snapshotIndex)).toEqual([2, 3, 4]);
        expect(result.lines[1].score).toMatchObject({ type: 'cp', value: -200 });
        const frame: ComparisonFrame = { id: 'frame', contextId: practiceContextId(fen, [], 'WHITE'),
            policyId: DEFAULT_ASSESSMENT_POLICY.id, engineFingerprint: practiceEngineFingerprint(snapshots[0].searchEvidence.engine),
            model: 'CP_ONLY', referenceAssessmentId: 'reference', status: 'CURRENT', supersededById: null };
        const assess = (items: AnalysisSnapshot[]) => assessMove(frame, { id: 'alternative', moveUci: 'd2d4', trainingSide: 'WHITE',
            referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: practiceEvidenceFromSnapshots([...probe.snapshots!, ...prior.snapshots!, ...items], 'WHITE', [probe.searchEvidence!, prior.searchEvidence!, result.searchEvidence!]) });
        expect(assess(snapshots.slice(0, 4))).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        expect(assess(snapshots)).toMatchObject({ quality: 'UNKNOWN' });
    });

    it('transports directional counters in order without evicting point convergence, and clears them only with a fresh complete point', async () => {
        const strong = 'info depth 10 multipv 2 score cp -200 upperbound nodes 1700 time 17 pv d2d4 d7d5';
        const weak = 'info depth 10 multipv 2 score cp 100 upperbound nodes 1750 time 18 pv d2d4 d7d5';
        const firstSlot = 'info depth 10 multipv 1 score cp 30 nodes 1800 time 19 pv e2e4 e7e5';
        const secondSlot = 'info depth 10 multipv 2 score cp 20 nodes 1900 time 20 pv d2d4 d7d5';
        const lines = withMatureNodes([...transcript.slice(0, 8), 'bestmove e2e4']);
        const { client } = setup(lines);
        const probe = await referenceProbe(client, lines);
        const prior = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 200_000, reuse: 'FRESH_REQUIRED' });
        lines.splice(0, lines.length, ...withMatureNodes([...transcript.slice(0, 8), strong, weak, firstSlot, secondSlot, 'bestmove e2e4']));
        const snapshots: AnalysisSnapshot[] = [];
        const result = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 200_000, reuse: 'FRESH_REQUIRED', onSnapshot: snapshot => snapshots.push(snapshot) });
        expect(result.searchEvidence?.id).not.toBe(prior.searchEvidence?.id);
        expect(snapshots.map(snapshot => snapshot.bundleComplete)).toEqual([true, true, true, true, false, false, true]);
        expect(snapshots.map(snapshot => snapshot.snapshotIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(snapshots[4].lines[0]).toMatchObject({ bound: 'UPPER', score: { type: 'cp', value: -200 } });
        const frame: ComparisonFrame = { id: 'frame', contextId: practiceContextId(fen, [], 'WHITE'),
            policyId: DEFAULT_ASSESSMENT_POLICY.id, engineFingerprint: practiceEngineFingerprint(snapshots[0].searchEvidence.engine),
            model: 'CP_ONLY', referenceAssessmentId: 'reference', status: 'CURRENT', supersededById: null };
        const assess = (items: AnalysisSnapshot[]) => assessMove(frame, { id: 'alternative', moveUci: 'd2d4', trainingSide: 'WHITE',
            referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: practiceEvidenceFromSnapshots([...probe.snapshots!, ...prior.snapshots!, ...items], 'WHITE', [probe.searchEvidence!, prior.searchEvidence!, result.searchEvidence!]) });
        expect(assess(snapshots.slice(0, 4))).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        expect(assess(snapshots.slice(0, 6))).toMatchObject({ quality: 'UNKNOWN' });
        expect(assess(result.snapshots!)).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        expect(result.snapshots?.map(snapshot => snapshot.snapshotIndex)).toEqual([2, 3, 6]);
        expect(result.boundLines).toEqual([]);
    });

    it('does not clear a bound with cached points from an older depth or a different MultiPV slot', async () => {
        const { client } = setup([...transcript.slice(0, 8),
            'info depth 11 multipv 1 score cp -200 upperbound nodes 1700 time 17 pv d2d4 d7d5',
            'info depth 10 multipv 1 score cp 30 nodes 1800 time 18 pv e2e4 e7e5',
            'info depth 12 multipv 1 score cp 30 nodes 1900 time 19 pv e2e4 e7e5',
            'bestmove e2e4']);
        const snapshots: AnalysisSnapshot[] = [];
        const result = await client.analyzeMultiPv({ fen, multiPv: 2, nodes: 2000, onSnapshot: snapshot => snapshots.push(snapshot) });
        expect(snapshots.map(snapshot => [snapshot.depth, snapshot.bundleComplete])).toEqual([[4, true], [6, true], [8, true], [10, true], [11, false]]);
        expect(result.snapshots?.filter(snapshot => !snapshot.bundleComplete)).toHaveLength(1);
        expect(result.boundLines).toEqual([expect.objectContaining({ moveUci: 'd2d4', bound: 'UPPER' })]);
    });

});
