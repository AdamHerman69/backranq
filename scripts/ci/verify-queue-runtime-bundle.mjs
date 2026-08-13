import { readFile } from 'node:fs/promises';
import path from 'node:path';

const routeDir = path.join(
    process.cwd(),
    '.next',
    'server',
    'app',
    'api',
    'queues',
    'backranq-jobs'
);
const nftPath = path.join(routeDir, 'route.js.nft.json');
const routePath = path.join(routeDir, 'route.js');
const required = [
    'src/lib/analysis/serverStockfishProcess.mjs',
    'stockfish/bin/stockfish-18-lite-single.js',
    'stockfish/bin/stockfish-18-lite-single.wasm',
    '@vercel/queue/dist/index.mjs',
];

const [nftText, routeText] = await Promise.all([
    readFile(nftPath, 'utf8'),
    readFile(routePath, 'utf8'),
]);
const trace = JSON.parse(nftText);
const files = Array.isArray(trace.files) ? trace.files : [];
const missing = required.filter(
    (suffix) => !files.some((file) => file.replaceAll('\\', '/').endsWith(suffix))
);
if (missing.length > 0) {
    throw new Error(
        `Queue runtime trace is missing: ${missing.join(', ')}`
    );
}
if (/\bfetch\s*=\s*null\b/.test(routeText)) {
    throw new Error(
        'Queue route still embeds the Stockfish fetch mutation'
    );
}

console.log(
    'Queue runtime bundle contains isolated Queue/Stockfish assets and no fetch mutation.'
);
