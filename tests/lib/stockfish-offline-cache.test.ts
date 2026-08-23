import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    STOCKFISH_BROWSER_CACHE_NAME,
    STOCKFISH_BROWSER_RUNTIME_ASSET_URLS,
} from '@/lib/analysis/stockfishMetadata';
import { prepareStockfishOfflineCache } from '@/lib/analysis/stockfishOfflineCache';

describe('Stockfish offline runtime cache', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('persists every versioned asset and reuses it without another fetch', async () => {
        const entries = new Map<string, Response>();
        const cache = {
            match: vi.fn(async (key: string) => entries.get(key)?.clone()),
            put: vi.fn(async (key: string, response: Response) => {
                entries.set(key, response.clone());
            }),
        };
        const open = vi.fn(async () => cache);
        const fetchRuntime = vi.fn(async (url: string | URL | Request) =>
            new Response(String(url), { status: 200 })
        );
        vi.stubGlobal('caches', { open });
        vi.stubGlobal('fetch', fetchRuntime);

        await expect(prepareStockfishOfflineCache()).resolves.toBe(true);
        expect(open).toHaveBeenCalledWith(STOCKFISH_BROWSER_CACHE_NAME);
        expect(fetchRuntime).toHaveBeenCalledTimes(
            STOCKFISH_BROWSER_RUNTIME_ASSET_URLS.length
        );
        expect([...entries.keys()]).toEqual(
            STOCKFISH_BROWSER_RUNTIME_ASSET_URLS
        );

        await expect(prepareStockfishOfflineCache()).resolves.toBe(true);
        expect(fetchRuntime).toHaveBeenCalledTimes(
            STOCKFISH_BROWSER_RUNTIME_ASSET_URLS.length
        );
    });

    it('does not claim offline readiness after an asset response fails', async () => {
        vi.stubGlobal('caches', {
            open: vi.fn(async () => ({
                match: vi.fn(async () => undefined),
                put: vi.fn(async () => undefined),
            })),
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 503 }))
        );

        await expect(prepareStockfishOfflineCache()).rejects.toThrow(
            'Stockfish offline asset failed with HTTP 503'
        );
    });

    it('keeps Stockfish out of service-worker install-time precaching', () => {
        const routeSource = readFileSync(
            resolve(process.cwd(), 'src/app/serwist/[path]/route.ts'),
            'utf8'
        );
        expect(routeSource).toContain("'public/vendor/stockfish/**/*'");
        expect(routeSource).toContain("'public/vendor/maia/**/*'");
    });
});
