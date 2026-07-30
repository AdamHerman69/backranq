import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';

const publicDir = path.resolve(process.cwd(), 'public');
const cases = [
    { name: 'start-e4', history: [], move: 'e2e4' },
    { name: 'start-a3', history: [], move: 'a2a3' },
    { name: 'start-f3', history: [], move: 'f2f3' },
    {
        name: 'fools-mate-g4',
        history: ['f2f3', 'e7e5'],
        move: 'g2g4',
    },
    {
        name: 'open-game-nxe5',
        history: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
        move: 'f3e5',
    },
    {
        name: 'ruy-exchange',
        history: [
            'e2e4',
            'e7e5',
            'g1f3',
            'b8c6',
            'f1b5',
            'a7a6',
        ],
        move: 'b5c6',
    },
    {
        name: 'ruy-retreat',
        history: [
            'e2e4',
            'e7e5',
            'g1f3',
            'b8c6',
            'f1b5',
            'a7a6',
        ],
        move: 'b5a4',
    },
    {
        name: 'qgd-pin',
        history: [
            'd2d4',
            'd7d5',
            'c2c4',
            'e7e6',
            'b1c3',
            'g8f6',
        ],
        move: 'c1g5',
    },
    {
        name: 'qgd-exchange',
        history: [
            'd2d4',
            'd7d5',
            'c2c4',
            'e7e6',
            'b1c3',
            'g8f6',
        ],
        move: 'c4d5',
    },
    {
        name: 'sicilian-mainline',
        history: [
            'e2e4',
            'c7c5',
            'g1f3',
            'd7d6',
            'd2d4',
            'c5d4',
            'f3d4',
            'g8f6',
        ],
        move: 'b1c3',
    },
    {
        name: 'sicilian-f3',
        history: [
            'e2e4',
            'c7c5',
            'g1f3',
            'd7d6',
            'd2d4',
            'c5d4',
            'f3d4',
            'g8f6',
        ],
        move: 'f2f3',
    },
    {
        name: 'french-space',
        history: [
            'e2e4',
            'e7e6',
            'd2d4',
            'd7d5',
            'b1c3',
            'f8b4',
        ],
        move: 'e4e5',
    },
    {
        name: 'french-a3',
        history: [
            'e2e4',
            'e7e6',
            'd2d4',
            'd7d5',
            'b1c3',
            'f8b4',
        ],
        move: 'a2a3',
    },
    {
        name: 'kings-indian-castle',
        history: [
            'd2d4',
            'g8f6',
            'c2c4',
            'g7g6',
            'b1c3',
            'f8g7',
            'e2e4',
            'd7d6',
            'g1f3',
            'e8g8',
        ],
        move: 'f1e2',
    },
    {
        name: 'kings-indian-h4',
        history: [
            'd2d4',
            'g8f6',
            'c2c4',
            'g7g6',
            'b1c3',
            'f8g7',
            'e2e4',
            'd7d6',
            'g1f3',
            'e8g8',
        ],
        move: 'h2h4',
    },
];

function materialize(testCase) {
    const chess = new Chess();
    for (const uci of testCase.history) {
        const played = chess.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            promotion: uci.slice(4, 5) || undefined,
        });
        if (!played) throw new Error(`Illegal history move ${uci}`);
    }
    const beforeFen = chess.fen();
    const played = chess.move({
        from: testCase.move.slice(0, 2),
        to: testCase.move.slice(2, 4),
        promotion: testCase.move.slice(4, 5) || undefined,
    });
    if (!played) throw new Error(`Illegal tested move ${testCase.move}`);
    return { ...testCase, beforeFen, afterFen: chess.fen() };
}

const corpus = cases.map(materialize);
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
]);

const server = http.createServer(async (request, response) => {
    if (request.url === '/') {
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
        });
        response.end('<!doctype html><title>Coach benchmark</title>');
        return;
    }
    const asset = assets.get(request.url ?? '');
    if (!asset) {
        response.writeHead(404).end();
        return;
    }
    const body = await fs.readFile(path.join(publicDir, asset.file));
    response.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-store',
    });
    response.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') {
    throw new Error('Could not bind coach benchmark server');
}

const budgets = [70_000, 240_000, 600_000];
let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const samples = await page.evaluate(
        async ({ corpus: browserCorpus, budgets: browserBudgets }) => {
            const worker = new Worker(
                '/vendor/stockfish/backranq-engine.worker.js'
            );
            let sequence = 0;
            const analyze = (fen, nodes) =>
                new Promise((resolve, reject) => {
                    const id = `benchmark-${sequence++}`;
                    const startedAt = performance.now();
                    const timeout = window.setTimeout(
                        () => reject(new Error(`Timeout at ${nodes} nodes`)),
                        60_000
                    );
                    const listener = (event) => {
                        const message = event.data;
                        if (message?.id !== id) return;
                        if (message.type === 'error') {
                            window.clearTimeout(timeout);
                            worker.removeEventListener('message', listener);
                            reject(new Error(message.message));
                        } else if (message.type === 'done') {
                            window.clearTimeout(timeout);
                            worker.removeEventListener('message', listener);
                            const line = message.final?.lines?.[0] ?? null;
                            resolve({
                                score: line?.score ?? null,
                                wdl: line?.wdl ?? null,
                                depth: line?.depth ?? message.final?.depth,
                                actualNodes:
                                    line?.nodes ?? message.final?.nodes,
                                elapsedMs: performance.now() - startedAt,
                            });
                        }
                    };
                    worker.addEventListener('message', listener);
                    worker.postMessage({
                        type: 'start',
                        id,
                        fen,
                        multiPv: 1,
                        maxNodes: nodes,
                        emitIntervalMs: 100,
                    });
                });

            const output = [];
            for (const testCase of browserCorpus) {
                for (const nodes of browserBudgets) {
                    const before = await analyze(testCase.beforeFen, nodes);
                    const after = await analyze(testCase.afterFen, nodes);
                    output.push({
                        name: testCase.name,
                        nodes,
                        before,
                        after,
                    });
                }
            }
            worker.terminate();
            return output;
        },
        { corpus, budgets }
    );

    const cpLoss = (sample) => {
        if (
            sample.before.score?.type !== 'cp' ||
            sample.after.score?.type !== 'cp'
        ) {
            return null;
        }
        return Math.max(
            0,
            sample.before.score.value + sample.after.score.value
        );
    };
    const referenceNodes = budgets.at(-1);
    const reference = new Map(
        samples
            .filter((sample) => sample.nodes === referenceNodes)
            .map((sample) => [sample.name, cpLoss(sample)])
    );
    const summary = budgets.map((nodes) => {
        const rows = samples.filter((sample) => sample.nodes === nodes);
        const errors = rows
            .map((sample) => {
                const observed = cpLoss(sample);
                const expected = reference.get(sample.name);
                return observed == null || expected == null
                    ? null
                    : Math.abs(observed - expected);
            })
            .filter((value) => value != null);
        const latencies = rows
            .map(
                (sample) =>
                    sample.before.elapsedMs + sample.after.elapsedMs
            )
            .sort((left, right) => left - right);
        const percentile = (ratio) =>
            latencies[
                Math.min(
                    latencies.length - 1,
                    Math.floor(latencies.length * ratio)
                )
            ];
        const classifications = [50, 100, 200].map((threshold) => {
            let falsePositive = 0;
            let falseNegative = 0;
            for (const sample of rows) {
                const observed = cpLoss(sample);
                const expected = reference.get(sample.name);
                if (observed == null || expected == null) continue;
                if (observed >= threshold && expected < threshold) {
                    falsePositive += 1;
                }
                if (observed < threshold && expected >= threshold) {
                    falseNegative += 1;
                }
            }
            return { threshold, falsePositive, falseNegative };
        });
        return {
            nodes,
            positions: rows.length,
            meanAbsoluteCpError:
                errors.reduce((sum, value) => sum + value, 0) /
                Math.max(1, errors.length),
            maxAbsoluteCpError: Math.max(0, ...errors),
            pairLatencyMs: {
                p50: percentile(0.5),
                p90: percentile(0.9),
                p95: percentile(0.95),
            },
            classifications,
        };
    });
    console.log(
        JSON.stringify(
            {
                engine: 'Stockfish 18 lite-single WASM',
                referenceNodes,
                corpusSize: corpus.length,
                summary,
                samples: samples.map((sample) => ({
                    name: sample.name,
                    nodes: sample.nodes,
                    lossCp: cpLoss(sample),
                    beforeDepth: sample.before.depth,
                    afterDepth: sample.after.depth,
                })),
            },
            null,
            2
        )
    );
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
