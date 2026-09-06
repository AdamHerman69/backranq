// Isolated, read-only engine experiment. No app/DB/service provider requests.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';

const reportName = process.env.BACKRANQ_RUNTIME_AUDIT_DIRECTORY ?? 'runtime-parity';
if (!/^[a-z0-9-]+$/i.test(reportName)) throw new Error('Invalid audit directory');
const directory = path.resolve('artifacts/extraction-quality-lab', reportName);
await fs.mkdir(directory, { recursive: true });
const browserBundle = await build({
    stdin: { contents: "export {StockfishClient} from './src/lib/analysis/stockfishClient';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'AuditEngine', write: false,
});
const serverPath = path.join(directory, 'server-client.mjs');
await build({
    stdin: { contents: "export {ServerStockfishClient} from './src/lib/analysis/serverStockfishClient';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: serverPath,
});
const { ServerStockfishClient } = await import(pathToFileURL(serverPath).href);
const positions = [
    { id: 'initial', fen: new Chess().fen(), nodes: 100_000, multiPv: 5 },
    { id: 'golden-mate-root', fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', nodes: 100_000, multiPv: 5 },
    { id: 'two-legal-in-check', fen: '7k/8/5Q2/8/6K1/8/8/8 b - - 0 1', nodes: 100_000, multiPv: 5 },
    { id: 'checkmate-terminal', fen: '5Q1k/8/6K1/8/8/8/8/8 b - - 1 1', nodes: 100_000, multiPv: 1 },
    { id: 'stalemate-terminal', fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', nodes: 100_000, multiPv: 1 },
];
for (const position of positions) {
    const chess = new Chess(position.fen);
    position.rules = { legalMoves: chess.moves(), checkmate: chess.isCheckmate(), stalemate: chess.isStalemate() };
}
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Runtime parity audit</title><script src="/audit-engine.js"></script>'); return; }
    if (pathname === '/audit-engine.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(browserBundle.outputFiles[0].contents); return; }
    const allowed = ['/vendor/stockfish/backranq-engine.worker.js', '/vendor/stockfish/stockfish-18-lite-single.js', '/vendor/stockfish/stockfish-18-lite-single.wasm'];
    if (!allowed.includes(pathname)) { response.writeHead(404).end(); return; }
    try {
        response.writeHead(200, { 'content-type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'public, max-age=3600' });
        response.end(await fs.readFile(path.join(process.cwd(), 'public', pathname)));
    } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const rows = [];
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const position of positions) {
        const browserResult = await page.evaluate(async (request) => {
            const { id, fen, nodes, multiPv } = request;
            const opts = { fen, nodes, multiPv };
            const engine = new AuditEngine.StockfishClient();
            const output = { id, startupMs: 0, calls: [] };
            const start = performance.now();
            try {
                output.identity = await engine.getIdentity();
                output.startupMs = performance.now() - start;
                for (const mode of ['cold-search', 'same-request', 'bypass-memo']) {
                    const began = performance.now();
                    try {
                        const result = await engine.analyzeMultiPv({ ...opts, timeoutMs: 30_000, reuse: mode === 'same-request' ? 'REUSE_ALLOWED' : 'FRESH_REQUIRED' });
                        output.calls.push({ mode, wallMs: performance.now() - began, result });
                    } catch (error) { output.calls.push({ mode, wallMs: performance.now() - began, error: String(error) }); }
                }
            } finally { engine.terminate(); }
            return output;
        }, position);
        const engine = new ServerStockfishClient();
        const serverResult = { id: position.id, calls: [] };
        try {
            const start = performance.now();
            serverResult.identity = await engine.getIdentity();
            serverResult.startupMs = performance.now() - start;
            for (const mode of ['cold-search', 'same-request', 'fresh-warm-search']) {
                const began = performance.now();
                try {
                    const result = await engine.analyzeMultiPv({ fen: position.fen, nodes: position.nodes, multiPv: position.multiPv, timeoutMs: 30_000 });
                    serverResult.calls.push({ mode, wallMs: performance.now() - began, result });
                } catch (error) { serverResult.calls.push({ mode, wallMs: performance.now() - began, error: String(error) }); }
            }
        } finally { engine.terminate(); }
        rows.push({ position, browser: browserResult, server: serverResult });
        console.log(JSON.stringify({ id: position.id, legalMoves: position.rules.legalMoves.length,
            browser: browserResult.calls.map((c) => ({ mode: c.mode, wallMs: Math.round(c.wallMs), roots: c.result?.lines.length, complete: c.result?.alternativesComplete, error: c.error })),
            server: serverResult.calls.map((c) => ({ mode: c.mode, wallMs: Math.round(c.wallMs), roots: c.result?.lines.length, complete: c.result?.alternativesComplete, error: c.error })),
        }));
    }
    const report = { generatedAt: new Date().toISOString(), sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, browser: browser.version(), notes: ['Fresh engine per position and adapter; sequential calls; local HTTP assets with browser HTTP cache retained between positions.', 'Browser getIdentity can resolve at uciok before Hash setup/readiness; startup and first call boundary is not identical to server.', 'Same-request browser cost is cache retrieval; bypass-memo intentionally issues a fresh search retaining hash.'], rows };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
