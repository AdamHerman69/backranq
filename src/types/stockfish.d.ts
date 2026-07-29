declare module 'stockfish/bin/stockfish-18-lite-single.js' {
    type EmscriptenModule = {
        locateFile?(path: string): string;
        print?(line: unknown): void;
        printErr?(line: unknown): void;
        [key: string]: unknown;
    };

    type InitializedModule = EmscriptenModule & {
        ccall(
            name: string,
            returnType: null,
            argumentTypes: string[],
            args: string[],
            options: { async: boolean }
        ): unknown;
        _isReady?: () => boolean;
        terminate?: () => void;
    };

    function StockfishModule(): (
        module: EmscriptenModule
    ) => Promise<InitializedModule>;

    export = StockfishModule;
}

declare module 'stockfish/bin/stockfish-18-lite-single.wasm' {
    const path: string;
    export = path;
}
