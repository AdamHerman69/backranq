import {
    STOCKFISH_BROWSER_CACHE_NAME,
    STOCKFISH_BROWSER_RUNTIME_ASSET_URLS,
} from '@/lib/analysis/stockfishMetadata';

let activePreparation: Promise<boolean> | null = null;

async function prepareRuntimeCache(): Promise<boolean> {
    if (typeof caches === 'undefined' || typeof fetch === 'undefined') {
        return false;
    }

    const cache = await caches.open(STOCKFISH_BROWSER_CACHE_NAME);
    await Promise.all(
        STOCKFISH_BROWSER_RUNTIME_ASSET_URLS.map(async (assetUrl) => {
            if (await cache.match(assetUrl)) return;
            const response = await fetch(assetUrl, {
                credentials: 'same-origin',
            });
            if (!response.ok) {
                throw new Error(
                    `Stockfish offline asset failed with HTTP ${response.status}.`
                );
            }
            await cache.put(assetUrl, response.clone());
        })
    );

    const cached = await Promise.all(
        STOCKFISH_BROWSER_RUNTIME_ASSET_URLS.map((assetUrl) =>
            cache.match(assetUrl)
        )
    );
    return cached.every(Boolean);
}

/**
 * Persist the exact versioned browser runtime after the user opens Coach.
 * This deliberately stays out of service-worker installation so unrelated
 * visits never compete with the 7 MiB engine download.
 */
export function prepareStockfishOfflineCache(): Promise<boolean> {
    if (activePreparation) return activePreparation;
    const operation = prepareRuntimeCache().finally(() => {
        if (activePreparation === operation) activePreparation = null;
    });
    activePreparation = operation;
    return operation;
}
