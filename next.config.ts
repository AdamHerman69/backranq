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
            {
                source: '/:path*',
                headers: [
                    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
                    {
                        key: 'Cross-Origin-Embedder-Policy',
                        value: 'require-corp',
                    },
                ],
            },
        ];
    },
};

export default withSerwist(nextConfig);
