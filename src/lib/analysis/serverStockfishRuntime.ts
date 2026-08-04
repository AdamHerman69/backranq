import path from 'node:path';
import StockfishModule from 'stockfish/bin/stockfish-18-lite-single.js';

const wasmPath = path.join(
    process.cwd(),
    'node_modules',
    'stockfish',
    'bin',
    'stockfish-18-lite-single.wasm'
);

export type ServerStockfishRuntime = {
    listener?: (line: string) => void;
    sendCommand(command: string): void;
    terminate?: () => void;
};

type EmscriptenStockfishModule = ServerStockfishRuntime & {
    locateFile(path: string): string;
    print(line: unknown): void;
    printErr(line: unknown): void;
    ccall(
        name: string,
        returnType: null,
        argumentTypes: string[],
        args: string[],
        options: { async: boolean }
    ): unknown;
    _isReady?: () => boolean;
};

/**
 * Minimal Emscripten host for the exact Stockfish flavor we ship. Importing the
 * concrete build avoids tracing the package's unused 100+ MB engine variants.
 */
export async function createStockfish18LiteEngine(): Promise<ServerStockfishRuntime> {
    const existingUncaughtExceptionListeners = new Set(
        process.listeners('uncaughtException')
    );
    const existingUnhandledRejectionListeners = new Set(
        process.listeners('unhandledRejection')
    );
    const runtime: EmscriptenStockfishModule = {
        locateFile(path) {
            return path.endsWith('.wasm') ? wasmPath : path;
        },
        print(line) {
            runtime.listener?.(String(line));
        },
        printErr(line) {
            runtime.listener?.(String(line));
        },
        ccall() {
            throw new Error('Stockfish runtime is not initialized');
        },
        sendCommand() {
            throw new Error('Stockfish runtime is not initialized');
        },
    };

    const initialized = StockfishModule()(runtime);
    const addedUncaughtExceptionListeners = process
        .listeners('uncaughtException')
        .filter(
            (listener) =>
                !existingUncaughtExceptionListeners.has(listener)
        );
    const addedUnhandledRejectionListeners = process
        .listeners('unhandledRejection')
        .filter(
            (listener) =>
                !existingUnhandledRejectionListeners.has(listener)
        );
    let listenersRemoved = false;
    const removeRuntimeProcessListeners = () => {
        if (listenersRemoved) return;
        listenersRemoved = true;
        for (const listener of addedUncaughtExceptionListeners) {
            process.removeListener('uncaughtException', listener);
        }
        for (const listener of addedUnhandledRejectionListeners) {
            process.removeListener('unhandledRejection', listener);
        }
    };
    try {
        await initialized;
    } catch (error) {
        removeRuntimeProcessListeners();
        throw error;
    }

    const terminateRuntime = runtime.terminate?.bind(runtime);
    runtime.terminate = () => {
        try {
            terminateRuntime?.();
        } finally {
            removeRuntimeProcessListeners();
        }
    };

    while (runtime._isReady && !runtime._isReady()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    delete runtime._isReady;

    runtime.sendCommand = (command: string) => {
        setImmediate(() => {
            runtime.ccall(
                'command',
                null,
                ['string'],
                [command],
                { async: /^go\b/.test(command) }
            );
        });
    };

    return runtime;
}
