import path from 'node:path';
import { spawn } from 'node:child_process';

const processPath = path.join(
    process.cwd(),
    'src',
    'lib',
    'analysis',
    'serverStockfishProcess.mjs'
);
const wasmPath = path.join(
    process.cwd(),
    'node_modules',
    'stockfish',
    'bin',
    'stockfish-18-lite-single.wasm'
);
const STARTUP_TIMEOUT_MS = 20_000;

export type ServerStockfishRuntime = {
    listener?: (line: string) => void;
    errorListener?: (error: Error) => void;
    sendCommand(command: string): void;
    terminate?: () => void;
};

type ProcessMessage =
    | { type: 'ready' }
    | { type: 'line'; line: string }
    | { type: 'fatal'; error: string };

/**
 * Start Stockfish in an isolated Node child process.
 *
 * The upstream Emscripten runtime declares its own `fetch` binding. Keeping the
 * entire runtime in another process is a hard boundary: neither that
 * binding nor future process-global hooks from the engine can affect the Queue
 * SDK, Next.js, or any other code in the callback worker.
 */
export async function createStockfish18LiteEngine(): Promise<ServerStockfishRuntime> {
    const child = spawn(process.execPath, [processPath], {
        env: {
            ...process.env,
            BACKRANQ_STOCKFISH_WASM_PATH: wasmPath,
        },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let terminated = false;
    let startupSettled = false;

    const runtime: ServerStockfishRuntime = {
        sendCommand(command) {
            if (terminated || !child.connected) {
                throw new Error('Stockfish process is terminated');
            }
            child.send({ type: 'command', command });
        },
        terminate() {
            if (terminated) return;
            terminated = true;
            child.kill('SIGTERM');
        },
    };

    const startup = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            settle(() =>
                reject(
                    new Error(
                        `Stockfish process did not initialize within ${STARTUP_TIMEOUT_MS}ms`
                    )
                )
            );
        }, STARTUP_TIMEOUT_MS);

        const settle = (operation: () => void) => {
            if (startupSettled) return;
            startupSettled = true;
            clearTimeout(timeout);
            operation();
        };

        const fail = (error: Error) => {
            if (terminated) return;
            if (!startupSettled) {
                settle(() => reject(error));
                return;
            }
            terminated = true;
            runtime.errorListener?.(error);
        };

        child.on('message', (message: ProcessMessage) => {
            if (message.type === 'ready') {
                settle(resolve);
                return;
            }
            if (message.type === 'line') {
                runtime.listener?.(message.line);
                return;
            }
            fail(new Error(message.error));
        });
        child.once('error', fail);
        child.once('exit', (code, signal) => {
            if (terminated) return;
            fail(
                new Error(
                    `Stockfish process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`
                )
            );
        });
    });

    try {
        await startup;
        return runtime;
    } catch (error) {
        runtime.terminate?.();
        throw error;
    }
}
