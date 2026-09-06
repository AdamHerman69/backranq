export const STOCKFISH_BROWSER_REVISION =
    'stockfish-18.0.8-bridge-v5';

export const STOCKFISH_BROWSER_CACHE_NAME =
    `coach-engine-${STOCKFISH_BROWSER_REVISION}`;

function stockfishBrowserAssetUrl(fileName: string): string {
    return `/vendor/stockfish/${fileName}?v=${encodeURIComponent(
        STOCKFISH_BROWSER_REVISION
    )}`;
}

export const STOCKFISH_BROWSER_WORKER_URL = stockfishBrowserAssetUrl(
    'backranq-engine.worker.js'
);

export const STOCKFISH_BROWSER_NESTED_WORKER_URL = stockfishBrowserAssetUrl(
    'stockfish-18-lite-single.js'
);

export const STOCKFISH_BROWSER_WASM_URL = stockfishBrowserAssetUrl(
    'stockfish-18-lite-single.wasm'
);

export const STOCKFISH_BROWSER_RUNTIME_ASSET_URLS = [
    STOCKFISH_BROWSER_WORKER_URL,
    STOCKFISH_BROWSER_NESTED_WORKER_URL,
    STOCKFISH_BROWSER_WASM_URL,
] as const;
