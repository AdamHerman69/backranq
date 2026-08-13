import type { NextConfig } from 'next';
import { withSerwist } from '@serwist/turbopack';

const stockfishLiteRuntime = [
    './src/lib/analysis/serverStockfishProcess.mjs',
    './node_modules/stockfish/package.json',
    './node_modules/stockfish/bin/stockfish-18-lite-single.js',
    './node_modules/stockfish/bin/stockfish-18-lite-single.wasm',
    './node_modules/stockfish/Copying.txt',
];
const unusedStockfishVariants = [
    '**/node_modules/stockfish/bin/stockfish-18.wasm',
    '**/node_modules/stockfish/bin/stockfish-18-single.wasm',
    '**/node_modules/stockfish/bin/stockfish-18-lite.wasm',
];

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    // Neither runtime belongs in Turbopack's Queue callback chunk. Stockfish is
    // loaded only by serverStockfishProcess.mjs in a separate Node process;
    // Queue stays an external package so its request transport is untouched.
    serverExternalPackages: ['@vercel/queue', 'stockfish'],
    outputFileTracingIncludes: {
        '/api/queues/backranq-jobs': stockfishLiteRuntime,
    },
    outputFileTracingExcludes: {
        '/api/queues/backranq-jobs': unusedStockfishVariants,
        // Reveal uses the read-only portion of attemptService and never starts
        // the dynamically evaluated move path.
        '/api/training/moments/*/reveal': [
            '**/node_modules/stockfish/bin/*.wasm',
        ],
    },
    async headers() {
        return [
            {
                source: '/serwist/sw.js',
                headers: [
                    { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
                    { key: 'Service-Worker-Allowed', value: '/' },
                ],
            },
        ];
    },
};

export default withSerwist(nextConfig);
