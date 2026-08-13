import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';

const clients: ServerStockfishClient[] = [];

afterEach(() => {
    for (const client of clients.splice(0)) client.terminate();
    vi.unstubAllGlobals();
});

describe('ServerStockfishClient integration', () => {
    it('tears down the isolated runtime when the startup handshake cannot be sent', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand() {
                throw new Error('Stockfish IPC disconnected before UCI');
            },
            terminate: vi.fn(),
        };
        const client = new ServerStockfishClient({
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        await expect(client.getIdentity()).rejects.toThrow(
            'Stockfish IPC disconnected before UCI'
        );
        expect(runtime.terminate).toHaveBeenCalledOnce();
    });

    it('rejects an active search immediately when the isolated runtime exits', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci') {
                    queueMicrotask(() => runtime.listener?.('uciok'));
                } else if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                } else if (command.startsWith('go nodes ')) {
                    queueMicrotask(() =>
                        runtime.errorListener?.(
                            new Error('Stockfish child exited unexpectedly')
                        )
                    );
                }
            },
            terminate: vi.fn(),
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 15_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        await expect(
            client.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
            })
        ).rejects.toThrow('Stockfish child exited unexpectedly');
        expect(runtime.terminate).toHaveBeenCalledOnce();
    });

    it('treats a failed stop command as a rejected search instead of an uncaught error', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci') {
                    queueMicrotask(() => runtime.listener?.('uciok'));
                } else if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                } else if (command === 'stop') {
                    throw new Error('Stockfish process is terminated');
                }
            },
            terminate: vi.fn(),
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 15_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);
        const controller = new AbortController();
        const analysis = client.evalPosition({
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            nodes: 1_000,
            signal: controller.signal,
        });
        await vi.waitFor(() => {
            expect(runtime.listener).toBeTypeOf('function');
        });
        controller.abort();

        await expect(analysis).rejects.toThrow('Analysis aborted');
        expect(runtime.terminate).toHaveBeenCalledOnce();
    });

    it('replaces a poisoned runtime when IPC disconnects during search readiness', async () => {
        const runtimes: Array<{
            runtime: ServerStockfishRuntime;
            terminate: ReturnType<typeof vi.fn>;
        }> = [];
        const runtimeFactory = vi.fn(async () => {
            const generation = runtimes.length;
            let readyCommands = 0;
            const terminate = vi.fn();
            const runtime: ServerStockfishRuntime = {
                sendCommand(command) {
                    if (command === 'uci') {
                        queueMicrotask(() => runtime.listener?.('uciok'));
                    } else if (command === 'isready') {
                        readyCommands += 1;
                        if (generation === 0 && readyCommands === 2) {
                            throw new Error(
                                'Stockfish IPC disconnected during search readiness'
                            );
                        }
                        queueMicrotask(() => runtime.listener?.('readyok'));
                    } else if (command.startsWith('go nodes ')) {
                        queueMicrotask(() => {
                            runtime.listener?.(
                                'info depth 8 multipv 1 score cp 30 nodes 1000 pv e2e4'
                            );
                            runtime.listener?.('bestmove e2e4');
                        });
                    }
                },
                terminate,
            };
            runtimes.push({ runtime, terminate });
            return runtime;
        });
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 5_000,
            runtimeFactory,
        });
        clients.push(client);

        await expect(
            client.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
            })
        ).rejects.toThrow(
            'Stockfish IPC disconnected during search readiness'
        );
        expect(runtimes[0]?.terminate).toHaveBeenCalledOnce();

        await expect(
            client.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
            })
        ).resolves.toMatchObject({ bestMoveUci: 'e2e4' });
        expect(runtimeFactory).toHaveBeenCalledTimes(2);
    });

    it('uses a rule-exact mate-in-one fallback when bestmove arrives without a PV', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci') {
                    queueMicrotask(() => {
                        runtime.listener?.('id name Protocol Stockfish 18');
                        runtime.listener?.('uciok');
                    });
                    return;
                }
                if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                    return;
                }
                if (command.startsWith('go nodes ')) {
                    queueMicrotask(() => {
                        runtime.listener?.(
                            'info depth 1 seldepth 2 score mate 1 wdl 1000 0 0 nodes 1 nps 1000 time 1'
                        );
                        runtime.listener?.('bestmove f7g7');
                    });
                }
            },
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 5_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        const analyzed = await client.analyzeMultiPv({
            fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',
            nodes: 1_000,
            multiPv: 5,
        });

        expect(analyzed.bestMoveUci).toBe('f7g7');
        expect(analyzed.alternativesComplete).toBe(false);
        expect(analyzed.lines).toEqual([
            {
                multipv: 1,
                pvUci: ['f7g7'],
                score: { type: 'mate', value: 1 },
                wdl: { win: 1_000, draw: 0, loss: 0 },
                depth: 1,
                selDepth: 2,
                nodes: 1,
                nps: 1_000,
                timeMs: 1,
            },
        ]);
    });

    it('still rejects a non-terminal bestmove when no exact PV was returned', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci') {
                    queueMicrotask(() => {
                        runtime.listener?.('id name Protocol Stockfish 18');
                        runtime.listener?.('uciok');
                    });
                    return;
                }
                if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                    return;
                }
                if (command.startsWith('go nodes ')) {
                    queueMicrotask(() =>
                        runtime.listener?.('bestmove e2e4')
                    );
                }
            },
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 5_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        await expect(
            client.analyzeMultiPv({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
                multiPv: 5,
            })
        ).rejects.toThrow('Engine returned no exact PV');
    });

    it('marks a partial MultiPV depth bucket as incomplete', async () => {
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci') {
                    queueMicrotask(() => {
                        runtime.listener?.('id name Protocol Stockfish 18');
                        runtime.listener?.('uciok');
                    });
                    return;
                }
                if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                    return;
                }
                if (command.startsWith('go nodes ')) {
                    queueMicrotask(() => {
                        runtime.listener?.(
                            'info depth 8 multipv 1 score cp 30 nodes 1000 pv e2e4'
                        );
                        runtime.listener?.(
                            'info depth 8 multipv 2 score cp 20 nodes 1000 pv d2d4'
                        );
                        runtime.listener?.('bestmove e2e4');
                    });
                }
            },
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 5_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        const analyzed = await client.analyzeMultiPv({
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            nodes: 1_000,
            multiPv: 3,
        });

        expect(analyzed.lines.map((line) => line.multipv)).toEqual([1, 2]);
        expect(analyzed.alternativesComplete).toBe(false);
    });

    it('reuses hash across related positions with one explicit UCI session boundary', async () => {
        const commands: string[] = [];
        let positionFen = '';
        let activeMove = '';
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                commands.push(command);
                if (command === 'uci') {
                    queueMicrotask(() => {
                        runtime.listener?.('id name Protocol Stockfish 18');
                        runtime.listener?.(
                            'option name EvalFile type string default protocol.nnue'
                        );
                        runtime.listener?.('uciok');
                    });
                    return;
                }
                if (command === 'isready') {
                    queueMicrotask(() => runtime.listener?.('readyok'));
                    return;
                }
                if (command.startsWith('position fen ')) {
                    positionFen = command.slice('position fen '.length);
                    return;
                }
                if (command === 'stop') {
                    queueMicrotask(() =>
                        runtime.listener?.(`bestmove ${activeMove}`)
                    );
                    return;
                }
                if (!command.startsWith('go nodes ')) return;
                const nodes = Number(command.slice('go nodes '.length));
                const move = positionFen.includes(' b ')
                    ? 'e7e5'
                    : 'e2e4';
                activeMove = move;
                queueMicrotask(() => {
                    runtime.listener?.(
                        `info depth 8 seldepth 10 multipv 1 score cp 20 wdl 40 950 10 nodes ${nodes} nps 100000 time 1 pv ${move}`
                    );
                    if (nodes === 999_999) return;
                    runtime.listener?.(`bestmove ${move}`);
                });
            },
        };
        const client = new ServerStockfishClient({
            defaultTimeoutMs: 5_000,
            runtimeFactory: async () => runtime,
        });
        clients.push(client);

        const initial =
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const afterE4 =
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        const first = await client.evalPosition({
            fen: initial,
            nodes: 2_000,
        });
        const second = await client.evalPosition({
            fen: afterE4,
            nodes: 2_000,
        });

        expect(first.bestMoveUci).toBe('e2e4');
        expect(second.bestMoveUci).toBe('e7e5');
        expect(commands.filter((command) => command === 'ucinewgame')).toEqual([
            'ucinewgame',
        ]);

        const firstPosition = commands.indexOf(`position fen ${initial}`);
        const secondPosition = commands.indexOf(`position fen ${afterE4}`);
        expect(commands.slice(0, firstPosition)).toContain('ucinewgame');
        expect(
            commands
                .slice(firstPosition + 1, secondPosition)
                .includes('ucinewgame')
        ).toBe(false);
        for (const positionIndex of [firstPosition, secondPosition]) {
            expect(commands[positionIndex - 1]).toBe('isready');
            expect(commands[positionIndex - 2]).toBe(
                'setoption name MultiPV value 1'
            );
            expect(commands[positionIndex + 1]).toBe('go nodes 2000');
        }

        const controller = new AbortController();
        const cancelled = client.evalPosition({
            fen: initial,
            nodes: 999_999,
            signal: controller.signal,
        });
        while (!commands.includes('go nodes 999999')) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        controller.abort();
        await expect(cancelled).rejects.toThrow(/aborted/i);
        await client.evalPosition({ fen: afterE4, nodes: 2_000 });

        expect(commands.filter((command) => command === 'ucinewgame')).toEqual([
            'ucinewgame',
            'ucinewgame',
        ]);
        const stopIndex = commands.lastIndexOf('stop');
        const boundaryIndex = commands.lastIndexOf('ucinewgame');
        const recoveredPositionIndex = commands.lastIndexOf(
            `position fen ${afterE4}`
        );
        expect(stopIndex).toBeLessThan(boundaryIndex);
        expect(boundaryIndex).toBeLessThan(recoveredPositionIndex);
    });

    it(
        'loads the maintained Node runtime and honors a fixed node budget',
        async () => {
            const client = new ServerStockfishClient({
                defaultNodes: 2_000,
                defaultTimeoutMs: 15_000,
            });
            clients.push(client);

            const identity = await client.getIdentity();
            expect(identity.name).toContain('Stockfish 18');
            expect(identity.version).toBe('18.0.8');
            expect(identity.flavor).toBe('lite-single-nnue-wasm');
            expect(identity.source).toBe(
                'stockfish@18.0.8/server/stockfish-18-lite-single'
            );
            expect(identity.options).toMatchObject({
                Threads: 1,
                Hash: 64,
                UCI_ShowWDL: true,
            });
            expect(identity.evalFile).toMatch(/\.nnue$/);

            const result = await client.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 2_000,
                timeoutMs: 15_000,
            });
            expect(result.bestMoveUci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
            expect(result.pvUci.length).toBeGreaterThan(0);
            expect(result.nodes).toBeGreaterThanOrEqual(2_000);
            expect(result.depth).toBeGreaterThan(0);
        },
        20_000
    );

    it(
        'keeps the parent fetch binding callable and usable by Queue after engine startup',
        async () => {
            const parentFetch = globalThis.fetch;
            expect(parentFetch).toBeTypeOf('function');

            const client = new ServerStockfishClient({
                defaultNodes: 1_000,
                defaultTimeoutMs: 15_000,
            });
            clients.push(client);
            await client.getIdentity();

            expect(globalThis.fetch).toBe(parentFetch);
            const queueFetch = vi.fn().mockResolvedValue(
                Response.json({ messageId: 'queue-after-stockfish' })
            );
            vi.stubGlobal('fetch', queueFetch);
            const { QueueClient } = await import('@vercel/queue');
            const queue = new QueueClient({
                region: 'iad1',
                token: 'test-token',
                deploymentId: null,
            });

            await expect(
                queue.send('backranq-runtime-smoke', { ok: true })
            ).resolves.toEqual({ messageId: 'queue-after-stockfish' });
            expect(queueFetch).toHaveBeenCalledOnce();
            expect(queueFetch.mock.calls[0]?.[0]).toContain(
                '/api/v3/topic/backranq-runtime-smoke'
            );
        },
        20_000
    );

    it(
        'honors abort/timeout safety and remains reusable after stop',
        async () => {
            const client = new ServerStockfishClient({
                defaultTimeoutMs: 15_000,
            });
            clients.push(client);
            await client.getIdentity();

            const controller = new AbortController();
            controller.abort();
            await expect(
                client.evalPosition({
                    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    nodes: 1_000,
                    signal: controller.signal,
                })
            ).rejects.toThrow(/aborted/i);

            await expect(
                client.evalPosition({
                    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    nodes: 1_000_000_000,
                    timeoutMs: 1_000,
                })
            ).rejects.toThrow(/timeout/i);

            const recovered = await client.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
                timeoutMs: 15_000,
            });
            expect(recovered.bestMoveUci).not.toBe('');
        },
        20_000
    );
});
