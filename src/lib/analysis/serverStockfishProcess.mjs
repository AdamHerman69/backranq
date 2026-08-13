import StockfishModule from 'stockfish/bin/stockfish-18-lite-single.js';

const wasmPath = process.env.BACKRANQ_STOCKFISH_WASM_PATH;
if (!wasmPath) {
    throw new Error('Stockfish process is missing its WASM path');
}
if (typeof process.send !== 'function') {
    throw new Error('Stockfish runtime requires an IPC channel');
}

const runtime = {
    listener(line) {
        process.send?.({ type: 'line', line: String(line) });
    },
    locateFile(file) {
        return file.endsWith('.wasm') ? wasmPath : file;
    },
    print(line) {
        process.send?.({ type: 'line', line: String(line) });
    },
    printErr(line) {
        process.send?.({ type: 'line', line: String(line) });
    },
    ccall() {
        throw new Error('Stockfish runtime is not initialized');
    },
    sendCommand() {
        throw new Error('Stockfish runtime is not initialized');
    },
};

try {
    await StockfishModule()(runtime);
    while (runtime._isReady && !runtime._isReady()) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    delete runtime._isReady;

    process.on('message', (message) => {
        if (
            !message ||
            message.type !== 'command' ||
            typeof message.command !== 'string'
        ) {
            return;
        }
        setImmediate(() => {
            runtime.ccall(
                'command',
                null,
                ['string'],
                [message.command],
                { async: /^go\b/.test(message.command) }
            );
        });
    });
    process.send({ type: 'ready' });
} catch (error) {
    process.send?.({
        type: 'fatal',
        error: error instanceof Error ? error.message : String(error),
    });
    throw error;
}
