/// <reference lib="esnext" />
/// <reference lib="webworker" />

import type {
    PrecacheEntry,
    RuntimeCaching,
    SerwistGlobalConfig,
} from 'serwist';
import {
    CacheFirst,
    NetworkOnly,
    Serwist,
} from 'serwist';
import { MAIA_MODEL } from '@/lib/coach/maia/metadata';

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

function isRscRequest(request: Request): boolean {
    return (
        request.headers.get('RSC') === '1' ||
        request.headers.has('Next-Router-State-Tree') ||
        request.headers
            .get('Accept')
            ?.includes('text/x-component') === true
    );
}

const runtimeCaching: RuntimeCaching[] = [
    {
        matcher: ({ sameOrigin, url }) =>
            sameOrigin &&
            url.pathname.startsWith('/vendor/stockfish/'),
        handler: new CacheFirst({ cacheName: 'coach-engine-v1' }),
    },
    {
        matcher: ({ sameOrigin, url }) =>
            sameOrigin &&
            url.pathname.startsWith('/vendor/maia/') &&
            !url.searchParams.has('maia-refresh'),
        handler: new CacheFirst({
            cacheName: MAIA_MODEL.runtimeCacheName,
        }),
    },
    {
        matcher: ({ sameOrigin, url }) =>
            sameOrigin && url.pathname.startsWith('/_next/static/'),
        handler: new CacheFirst({ cacheName: 'next-static-immutable' }),
    },
    {
        matcher: ({ sameOrigin, url, request }) =>
            sameOrigin &&
            (url.pathname.startsWith('/api/') ||
                url.pathname.startsWith('/auth/') ||
                isRscRequest(request)),
        handler: new NetworkOnly(),
    },
    {
        matcher: ({ sameOrigin, url, request }) =>
            sameOrigin &&
            url.pathname === '/play' &&
            request.mode === 'navigate',
        handler: new NetworkOnly({ networkTimeoutSeconds: 4 }),
    },
    {
        matcher: /.*/i,
        handler: new NetworkOnly(),
    },
];

const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    precacheOptions: {
        cleanupOutdatedCaches: true,
    },
    skipWaiting: false,
    clientsClaim: false,
    navigationPreload: true,
    runtimeCaching,
    fallbacks: {
        entries: [
            {
                url: '/~offline/coach',
                matcher({ request }) {
                    return (
                        request.destination === 'document' &&
                        ['/home', '/play'].includes(
                            new URL(request.url).pathname
                        )
                    );
                },
            },
        ],
    },
});

serwist.addEventListeners();

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) =>
            Promise.all(
                cacheNames
                    .filter(
                        (cacheName) =>
                            cacheName.startsWith(
                                'coach-maia-runtime-'
                            ) &&
                            cacheName !==
                                MAIA_MODEL.runtimeCacheName
                    )
                    .map((cacheName) => caches.delete(cacheName))
            )
        )
    );
});
