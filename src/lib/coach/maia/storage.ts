'use client';

import {
    MAIA_CACHE_DATABASE,
    MAIA_CACHE_KEY,
    MAIA_CACHE_STORE,
    MAIA_CACHE_VERSION,
} from '@/lib/coach/maia/cache';
import {
    MAIA_MODEL,
    MAIA_RUNTIME_FILES,
    maiaRuntimeAssetUrl,
} from '@/lib/coach/maia/metadata';

export type MaiaOfflineInstallStatus = {
    checking: boolean;
    modelStored: boolean;
    runtimeStored: boolean;
    installed: boolean;
    hasStoredData: boolean;
};

export const UNKNOWN_MAIA_INSTALL_STATUS: MaiaOfflineInstallStatus = {
    checking: true,
    modelStored: false,
    runtimeStored: false,
    installed: false,
    hasStoredData: false,
};

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

async function storedModelState(): Promise<{
    modelStored: boolean;
    hasModelData: boolean;
}> {
    if (typeof indexedDB === 'undefined') {
        return { modelStored: false, hasModelData: false };
    }
    const database = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(
            MAIA_CACHE_DATABASE,
            MAIA_CACHE_VERSION
        );
        request.onupgradeneeded = () => {
            if (
                !request.result.objectStoreNames.contains(
                    MAIA_CACHE_STORE
                )
            ) {
                request.result.createObjectStore(MAIA_CACHE_STORE, {
                    keyPath: 'key',
                });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
    if (!database) {
        return { modelStored: false, hasModelData: false };
    }
    try {
        const transaction = database.transaction(
            MAIA_CACHE_STORE,
            'readonly'
        );
        const keys = await requestResult(
            transaction
                .objectStore(MAIA_CACHE_STORE)
                .getAllKeys()
        );
        return {
            modelStored: keys?.includes(MAIA_CACHE_KEY) === true,
            hasModelData: (keys?.length ?? 0) > 0,
        };
    } catch {
        return { modelStored: false, hasModelData: false };
    } finally {
        database.close();
    }
}

async function runtimeCacheState(): Promise<{
    runtimeStored: boolean;
    hasRuntimeData: boolean;
}> {
    if (typeof caches === 'undefined') {
        return { runtimeStored: false, hasRuntimeData: false };
    }
    try {
        const cacheNames = (await caches.keys()).filter((name) =>
            name.startsWith('coach-maia-runtime-')
        );
        if (cacheNames.length === 0) {
            return { runtimeStored: false, hasRuntimeData: false };
        }
        const current = await caches.open(
            MAIA_MODEL.runtimeCacheName
        );
        const matches = await Promise.all(
            MAIA_RUNTIME_FILES.map((fileName) =>
                current.match(maiaRuntimeAssetUrl(fileName))
            )
        );
        return {
            runtimeStored: matches.every(Boolean),
            hasRuntimeData: true,
        };
    } catch {
        return { runtimeStored: false, hasRuntimeData: false };
    }
}

export async function inspectMaiaOfflineData(): Promise<MaiaOfflineInstallStatus> {
    const [model, runtime] = await Promise.all([
        storedModelState(),
        runtimeCacheState(),
    ]);
    return {
        checking: false,
        modelStored: model.modelStored,
        runtimeStored: runtime.runtimeStored,
        installed: model.modelStored && runtime.runtimeStored,
        hasStoredData: model.hasModelData || runtime.hasRuntimeData,
    };
}

function deleteModelDatabase(): Promise<void> {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(MAIA_CACHE_DATABASE);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(
                request.error ??
                    new Error('Could not remove the Maia model database.')
            );
        request.onblocked = () =>
            reject(
                new Error(
                    'Close other Backranq tabs before removing the Maia model.'
                )
            );
    });
}

export async function clearMaiaOfflineData(): Promise<void> {
    await deleteModelDatabase();
    if (typeof caches === 'undefined') return;
    await Promise.all(
        (await caches.keys())
            .filter((name) => name.startsWith('coach-maia-runtime-'))
            .map((name) => caches.delete(name))
    );
}
