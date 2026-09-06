// Browser counterpart to the bounded quality-lab server STANDARD sample.
// Only a local asset server and versioned corpus; no app/DB/tablebase requests.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const reportName = process.env.BACKRANQ_BROWSER_EXTRACTION_DIRECTORY ?? 'browser-extraction';
if (!/^[a-z0-9-]+$/i.test(reportName)) throw new Error('Invalid audit directory');
const directory = path.resolve('artifacts/extraction-quality-lab', reportName);
const comparisonDirectory = process.env.BACKRANQ_BROWSER_COMPARISON_DIRECTORY ?? 'audit';
if (!/^[a-z0-9-]+$/i.test(comparisonDirectory)) throw new Error('Invalid comparison directory');
await fs.mkdir(directory, { recursive: true });
const corpusBytes = await fs.readFile('tests/fixtures/training-v2/real-games.corpus.v1.json');
const corpus = JSON.parse(corpusBytes);
const selectedIds = ['chesscom:0f8e42f0-8fda-11f1-b9f6-9dd41a01000f', 'lichess:bNDgiSuy'];
const games = selectedIds.map((id) => corpus.games.find((game) => game.id === id));
if (games.some((game) => !game)) throw new Error('Required versioned sample games absent');
const bundle = await build({
    stdin: { contents: "export {StockfishClient} from './src/lib/analysis/stockfishClient'; export {extractTrainingMomentsFromGames} from './src/lib/analysis/extractTrainingMoments';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'AuditExtraction', write: false,
});
const assetRequests = [];
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Browser extraction audit</title><script src="/audit-extractor.js"></script>'); return; }
    if (pathname === '/audit-extractor.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundle.outputFiles[0].contents); return; }
    const allowed = ['/vendor/stockfish/backranq-engine.worker.js', '/vendor/stockfish/stockfish-18-lite-single.js', '/vendor/stockfish/stockfish-18-lite-single.wasm'];
    if (!allowed.includes(pathname)) { response.writeHead(404).end(); return; }
    try {
        const contents = await fs.readFile(path.join(process.cwd(), 'public', pathname));
        assetRequests.push({ path: request.url, bytes: contents.length, time: new Date().toISOString() });
        response.writeHead(200, { 'content-type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'public, max-age=3600' });
        response.end(contents);
    } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const metadata = { generatedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'), environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model } };
let browser;
const summaries = [];
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (message) => { if (message.text().startsWith('AUDIT_PROGRESS')) console.log(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const game of games) {
        const result = await page.evaluate(async (game) => {
            const calls = [];
            const physicalSearches = [];
            const liveSearches = new Map();
            const BaseWorker = window.Worker;
            class ObservedWorker extends BaseWorker {
                constructor(...args) {
                    super(...args);
                    this.addEventListener('message', (event) => {
                        const message = event.data;
                        const search = liveSearches.get(message?.id);
                        if (!search) return;
                        if (message.type === 'update' || message.type === 'done') {
                            const update = message.final ?? message.update;
                            search.reportedNodes = Math.max(search.reportedNodes, update?.nodes ?? 0);
                            search.reportedEngineTimeMs = Math.max(search.reportedEngineTimeMs, update?.timeMs ?? 0);
                        }
                        if (['done', 'error', 'cancelled'].includes(message.type)) {
                            search.wallMs = performance.now() - search.startedAt;
                            search.termination = message.type;
                            if (message.type === 'error') search.error = message.message;
                            liveSearches.delete(message.id);
                        }
                    });
                }
                postMessage(message, ...rest) {
                    if (message?.type === 'start') {
                        const search = { id: message.id, fen: message.fen, requestedNodes: message.maxNodes, multiPv: message.multiPv, startedAt: performance.now(), reportedNodes: 0, reportedEngineTimeMs: 0 };
                        physicalSearches.push(search);
                        liveSearches.set(message.id, search);
                    }
                    return super.postMessage(message, ...rest);
                }
            }
            window.Worker = ObservedWorker;
            const start = performance.now();
            const client = new AuditExtraction.StockfishClient();
            let startupMs = 0;
            const engine = {
                async getIdentity() {
                    const began = performance.now();
                    try { return await client.getIdentity(); }
                    finally { startupMs += performance.now() - began; }
                },
            };
            for (const method of ['evalPosition', 'analyzeMultiPv']) {
                engine[method] = async (options) => {
                    const beforeCount = physicalSearches.length;
                    const call = { kind: method === 'evalPosition' ? 'eval' : 'multipv', fen: options.fen, requestedNodes: options.nodes, multiPv: options.multiPv ?? 1, caller: (new Error().stack ?? '').split('\n').slice(2, 9) };
                    calls.push(call);
                    const began = performance.now();
                    try {
                        const value = await client[method](options);
                        call.result = value;
                        return value;
                    } catch (error) { call.error = String(error); throw error; }
                    finally {
                        call.wallTimeMs = performance.now() - began;
                        call.physicalSearchIds = physicalSearches.slice(beforeCount).map((search) => search.id);
                        call.reusedEvidence = call.physicalSearchIds.length === 0;
                    }
                };
            }
            let output = null;
            let error = null;
            let lastPrintedPly = -10;
            try {
                const raw = await AuditExtraction.extractTrainingMomentsFromGames({
                    games: [game], selectedGameIds: new Set([game.id]), engine,
                    onProgress(progress) { if (progress.ply >= lastPrintedPly + 10) { lastPrintedPly = progress.ply; console.log(`AUDIT_PROGRESS ${game.id} ${progress.ply}/${progress.plyCount}`); } },
                    options: { returnAnalysis: true, nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, verificationNodesPerPosition: 100_000, multiPv: 5, maxMultiPv: 16, maxAcceptedMoves: 16 },
                });
                output = { ...raw, analysis: raw.analysis ? Object.fromEntries(raw.analysis) : null };
            } catch (failure) { error = String(failure); }
            finally { client.terminate(); window.Worker = BaseWorker; }
            return { totalMs: performance.now() - start, startupMs, calls, physicalSearches, output, error };
        }, game);
        const report = { ...metadata, gameId: game.id, browser: browser.version(), telemetryNote: 'Fresh browser engine per game aligns with server lab. Outer Worker start messages count issued physical searches; bridge streaming snapshot max nodes/time is lower-bound telemetry, not raw UCI. No DB/tablebase; HTTP cache retained between games. Browser getIdentity can complete before readiness; totalMs includes startup and extraction.', ...result };
        const filename = `${game.id.replace(/[^a-z0-9.-]/gi, '_')}.json`;
        await fs.writeFile(path.join(directory, filename), JSON.stringify(report, null, 2) + '\n');
        const serverEvidence = JSON.parse(await fs.readFile(path.resolve('artifacts/extraction-quality-lab', comparisonDirectory, `product-${filename}`)));
        const browserMoments = result.output?.moments ?? [];
        const serverMoments = serverEvidence.output?.moments ?? [];
        const summary = { gameId: game.id, complete: result.output?.manifests?.[0]?.complete, browserTotalMs: result.totalMs, serverTotalMs: serverEvidence.totalMs, browserRequests: result.calls.length, browserPhysicalSearches: result.physicalSearches.length, serverRequests: serverEvidence.calls.length, browserTrainable: browserMoments.filter((m) => m.solution.trainable).map((m) => m.decisionPly), serverTrainable: serverMoments.filter((m) => m.solution.trainable).map((m) => m.decisionPly), browserReasons: result.output?.analysis?.[game.id]?.trainingExtraction?.summary?.reasons, serverReasons: serverEvidence.output?.analysis?.[game.id]?.trainingExtraction?.summary?.reasons, error: result.error };
        summaries.push(summary);
        console.log(JSON.stringify(summary));
    }
    await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ ...metadata, summaries, assetRequests }, null, 2) + '\n');
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
