export const STOCKFISH_BROWSER_REVISION =
    'stockfish-18.0.8-bridge-v3';

export const STOCKFISH_BROWSER_CACHE_NAME =
    `coach-engine-${STOCKFISH_BROWSER_REVISION}`;

export const STOCKFISH_BROWSER_WORKER_URL =
    `/vendor/stockfish/backranq-engine.worker.js?v=${encodeURIComponent(
        STOCKFISH_BROWSER_REVISION
    )}`;
