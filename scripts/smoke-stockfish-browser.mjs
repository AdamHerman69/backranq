import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';

const publicDir = path.resolve(process.cwd(), 'public');
const protocolWorkerSource = `
const commands = [];
let currentFen = '';
self.onmessage = (event) => {
    const command = String(event.data ?? '');
    commands.push(command);
    self.postMessage(
        'id author protocol:' + encodeURIComponent(JSON.stringify(commands))
    );
    if (command === 'uci') {
        self.postMessage('id name Protocol Stockfish 18');
        self.postMessage(
            'option name EvalFile type string default protocol.nnue'
        );
        self.postMessage('uciok');
        return;
    }
    if (command === 'isready') {
        self.postMessage('readyok');
        return;
    }
    if (command.startsWith('position fen ')) {
        currentFen = command.slice('position fen '.length);
        return;
    }
    if (!command.startsWith('go nodes ')) return;
    const nodes = Number(command.slice('go nodes '.length));
    const move = currentFen.includes(' b ') ? 'e7e5' : 'e2e4';
    self.postMessage(
        'info depth 8 seldepth 10 multipv 1 score cp 20 wdl 40 950 10 ' +
            'nodes ' + nodes + ' nps 100000 time 1 pv ' + move
    );
    self.postMessage('bestmove ' + move);
};
`;
const assets = new Map([
    [
        '/vendor/stockfish/backranq-engine.worker.js',
        {
            file: 'vendor/stockfish/backranq-engine.worker.js',
            type: 'text/javascript; charset=utf-8',
        },
    ],
    [
        '/vendor/stockfish/stockfish-18-lite-single.js',
        {
            file: 'vendor/stockfish/stockfish-18-lite-single.js',
            type: 'text/javascript; charset=utf-8',
        },
    ],
    [
        '/vendor/stockfish/stockfish-18-lite-single.wasm',
        {
            file: 'vendor/stockfish/stockfish-18-lite-single.wasm',
            type: 'application/wasm',
        },
    ],
    [
        '/protocol/backranq-engine.worker.js',
        {
            file: 'vendor/stockfish/backranq-engine.worker.js',
            type: 'text/javascript; charset=utf-8',
        },
    ],
    [
        '/protocol/stockfish-18-lite-single.js',
        {
            body: protocolWorkerSource,
            type: 'text/javascript; charset=utf-8',
        },
    ],
]);

const server = http.createServer(async (request, response) => {
    if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Stockfish smoke</title>');
        return;
    }
    const asset = assets.get(request.url ?? '');
    if (!asset) {
        response.writeHead(404).end();
        return;
    }
    try {
        const body =
            'body' in asset
                ? asset.body
                : await fs.readFile(path.join(publicDir, asset.file));
        response.writeHead(200, {
            'content-type': asset.type,
            'cache-control': 'no-store',
        });
        response.end(body);
    } catch (error) {
        response.writeHead(500).end(
            error instanceof Error ? error.message : String(error)
        );
    }
});

await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
    throw new Error('Could not bind browser smoke server');
}

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const protocol = await page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const worker = new Worker(
                    '/protocol/backranq-engine.worker.js'
                );
                const timeout = window.setTimeout(() => {
                    worker.terminate();
                    reject(
                        new Error('Browser Stockfish protocol probe timed out')
                    );
                }, 10_000);
                const jobs = [
                    {
                        id: 'protocol-initial',
                        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    },
                    {
                        id: 'protocol-after-e4',
                        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                    },
                ];
                let completed = 0;
                let awaitingFinalIdentity = false;
                const start = (job) => {
                    worker.postMessage({
                        type: 'start',
                        id: job.id,
                        fen: job.fen,
                        multiPv: 1,
                        maxNodes: 2_000,
                    });
                };
                worker.onmessage = (event) => {
                    const message = event.data;
                    if (message?.type === 'error') {
                        window.clearTimeout(timeout);
                        worker.terminate();
                        reject(new Error(message.message));
                        return;
                    }
                    if (
                        message?.type === 'identity' &&
                        awaitingFinalIdentity
                    ) {
                        window.clearTimeout(timeout);
                        worker.terminate();
                        try {
                            const encoded = String(
                                message.identity?.author ?? ''
                            ).replace(/^protocol:/, '');
                            resolve({
                                commands: JSON.parse(
                                    decodeURIComponent(encoded)
                                ),
                            });
                        } catch (error) {
                            reject(error);
                        }
                        return;
                    }
                    if (message?.type !== 'done') return;
                    completed += 1;
                    if (completed < jobs.length) {
                        start(jobs[completed]);
                        return;
                    }
                    awaitingFinalIdentity = true;
                    worker.postMessage({ type: 'identity' });
                };
                worker.onerror = (event) => {
                    window.clearTimeout(timeout);
                    worker.terminate();
                    reject(new Error(event.message));
                };
                start(jobs[0]);
            })
    );
    const expectedProtocol = [
        'uci',
        'setoption name Threads value 1',
        'setoption name Hash value 64',
        'setoption name UCI_ShowWDL value true',
        'ucinewgame',
        'isready',
        'setoption name MultiPV value 1',
        'isready',
        'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'go nodes 2000',
        'setoption name MultiPV value 1',
        'isready',
        'position fen rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        'go nodes 2000',
    ];
    if (
        !Array.isArray(protocol?.commands) ||
        JSON.stringify(protocol.commands) !== JSON.stringify(expectedProtocol)
    ) {
        throw new Error(
            `Unexpected browser UCI protocol: ${JSON.stringify(protocol)}`
        );
    }
    const result = await page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const worker = new Worker(
                    '/vendor/stockfish/backranq-engine.worker.js'
                );
                const timeout = window.setTimeout(() => {
                    worker.terminate();
                    reject(new Error('Browser Stockfish smoke timed out'));
                }, 30_000);
                let identity = null;
                const searches = [];
                const cancelled = [];
                let replacementStarted = false;
                const jobs = [
                    {
                        id: 'browser-smoke-opening',
                        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    },
                    {
                        id: 'browser-smoke-endgame',
                        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                    },
                ];
                const start = (job) => {
                    worker.postMessage({
                        type: 'start',
                        id: job.id,
                        fen: job.fen,
                        multiPv: 2,
                        maxNodes: job.maxNodes ?? 10_000,
                        emitIntervalMs: 50,
                    });
                };
                const superseded = {
                    id: 'browser-smoke-superseded',
                    fen: jobs[0].fen,
                    maxNodes: 1_000_000_000,
                };
                const replacement = {
                    id: 'browser-smoke-replacement',
                    fen: jobs[1].fen,
                    maxNodes: 10_000,
                };
                const tripleActive = {
                    id: 'browser-smoke-triple-active',
                    fen: jobs[0].fen,
                    maxNodes: 1_000_000_000,
                };
                const tripleQueued = {
                    id: 'browser-smoke-triple-queued',
                    fen: jobs[1].fen,
                    maxNodes: 1_000_000_000,
                };
                const tripleWinner = {
                    id: 'browser-smoke-triple-winner',
                    fen: jobs[0].fen,
                    maxNodes: 10_000,
                };
                const directStop = {
                    id: 'browser-smoke-direct-stop',
                    fen: jobs[1].fen,
                    maxNodes: 1_000_000_000,
                };
                let tripleQueuedOnce = false;
                let directStopSent = false;
                worker.onmessage = (event) => {
                    const message = event.data;
                    if (message?.type === 'identity') {
                        identity = message.identity;
                        return;
                    }
                    if (message?.type === 'error') {
                        window.clearTimeout(timeout);
                        worker.terminate();
                        reject(new Error(message.message));
                        return;
                    }
                    if (
                        message?.type === 'update' &&
                        message.id === superseded.id &&
                        !replacementStarted
                    ) {
                        replacementStarted = true;
                        start(replacement);
                        return;
                    }
                    if (
                        message?.type === 'update' &&
                        message.id === tripleActive.id &&
                        !tripleQueuedOnce
                    ) {
                        tripleQueuedOnce = true;
                        start(tripleQueued);
                        start(tripleWinner);
                        return;
                    }
                    if (
                        message?.type === 'update' &&
                        message.id === directStop.id &&
                        !directStopSent
                    ) {
                        directStopSent = true;
                        worker.postMessage({
                            type: 'stop',
                            id: directStop.id,
                        });
                        return;
                    }
                    if (message?.type === 'cancelled') {
                        cancelled.push({
                            id: message.id,
                            message: message.message,
                        });
                        if (message.id === directStop.id) {
                            window.clearTimeout(timeout);
                            worker.terminate();
                            resolve({ identity, searches, cancelled });
                        }
                        return;
                    }
                    if (message?.type === 'done') {
                        if (message.id === superseded.id) {
                            window.clearTimeout(timeout);
                            worker.terminate();
                            reject(
                                new Error(
                                    'Superseded fixed-node search was reported as done'
                                )
                            );
                            return;
                        }
                        searches.push({
                            id: message.id,
                            bestMoveUci: message.bestMoveUci,
                            final: message.final,
                        });
                        if (searches.length < jobs.length) {
                            start(jobs[searches.length]);
                        } else if (
                            message.id === jobs[jobs.length - 1].id
                        ) {
                            start(superseded);
                        } else if (message.id === replacement.id) {
                            start(tripleActive);
                        } else if (message.id === tripleWinner.id) {
                            start(directStop);
                        }
                    }
                };
                worker.onerror = (event) => {
                    window.clearTimeout(timeout);
                    worker.terminate();
                    reject(new Error(event.message));
                };
                worker.postMessage({ type: 'identity' });
                start(jobs[0]);
            })
    );

    const searches = result?.searches;
    const cancelled = result?.cancelled;
    const cancelledIds = new Set(
        Array.isArray(cancelled)
            ? cancelled.map((entry) => entry.id)
            : []
    );
    if (
        !result ||
        typeof result !== 'object' ||
        !result.identity ||
        !String(result.identity.name).includes('Stockfish 18') ||
        result.identity.version !== '18.0.8' ||
        result.identity.flavor !== 'lite-single-nnue-wasm' ||
        result.identity.source !==
            'stockfish@18.0.8/browser/stockfish-18-lite-single' ||
        result.identity.options?.Threads !== 1 ||
        result.identity.options?.Hash !== 64 ||
        result.identity.options?.UCI_ShowWDL !== true ||
        !String(result.identity.evalFile ?? '').endsWith('.nnue') ||
        !Array.isArray(searches) ||
        searches.length !== 4 ||
        !Array.isArray(cancelled) ||
        cancelled.length !== 4 ||
        ![
            'browser-smoke-superseded',
            'browser-smoke-triple-active',
            'browser-smoke-triple-queued',
            'browser-smoke-direct-stop',
        ].every((id) => cancelledIds.has(id)) ||
        searches.some(
            (search) =>
                !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(
                    search.bestMoveUci
                ) ||
                !Array.isArray(search.final?.lines) ||
                search.final.lines.length < 1 ||
                !(search.final.nodes >= 10_000)
        )
    ) {
        throw new Error(
            `Unexpected browser engine result: ${JSON.stringify(result)}`
        );
    }
    console.log(
        JSON.stringify({
            ok: true,
            protocol: {
                searches: 2,
                uciNewGameCommands: protocol.commands.filter(
                    (command) => command === 'ucinewgame'
                ).length,
            },
            identity: result.identity,
            searches: searches.map((search) => ({
                id: search.id,
                bestMoveUci: search.bestMoveUci,
                nodes: search.final.nodes,
                lines: search.final.lines.length,
            })),
            cancelled,
        })
    );
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
