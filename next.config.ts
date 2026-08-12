import type { NextConfig } from 'next';
import { withSerwist } from '@serwist/turbopack';

const stockfishLiteRuntime = [
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
    // Keep the queue SDK out of Turbopack's combined worker chunk. When it is
    // bundled beside Stockfish, the SDK's internal fetch call can be rewritten
    // to a non-callable chunk binding, which breaks visibility changes/retries.
    serverExternalPackages: ['@vercel/queue'],
    outputFileTracingIncludes: {
        '/api/queues/backranq-jobs': stockfishLiteRuntime,
        '/api/training/moments/*/attempts': stockfishLiteRuntime,
    },
    outputFileTracingExcludes: {
        '/api/queues/backranq-jobs': unusedStockfishVariants,
        '/api/training/moments/*/attempts':
            unusedStockfishVariants,
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
