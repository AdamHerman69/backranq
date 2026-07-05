declare module 'stockfish.wasm' {
    type StockfishInstance = {
        postMessage(message: string): void;
        addMessageListener(listener: (line: string) => void): void;
        terminate?: () => void;
    };

    function Stockfish(): Promise<StockfishInstance>;
    export = Stockfish;
}
