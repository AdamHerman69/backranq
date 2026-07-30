import { describe, expect, it } from 'vitest';

import {
    isCompatibleMaiaCacheEntry,
    MAIA_CACHE_KEY,
    MAIA_CACHE_VERSION,
} from '@/lib/coach/maia/cache';
import {
    MAIA_MODEL,
    maiaRuntimeAssetUrl,
} from '@/lib/coach/maia/metadata';

describe('Maia model cache versioning', () => {
    it('uses the complete engine revision for runtime URLs and cache names', () => {
        expect(MAIA_MODEL.runtimeCacheName).toContain(
            MAIA_MODEL.engineRevision
        );
        expect(
            maiaRuntimeAssetUrl('backranq-maia.worker.js')
        ).toContain(encodeURIComponent(MAIA_MODEL.engineRevision));
    });
    it('accepts only exact model version, digest, size and ArrayBuffer bytes', () => {
        const bytes = new ArrayBuffer(MAIA_MODEL.byteLength);
        const entry = {
            key: MAIA_CACHE_KEY,
            modelId: MAIA_MODEL.id,
            modelVersion: MAIA_MODEL.version,
            sha256: MAIA_MODEL.sha256,
            byteLength: MAIA_MODEL.byteLength,
            bytes,
            cachedAt: 123,
        };

        expect(MAIA_CACHE_VERSION).toBe(1);
        expect(isCompatibleMaiaCacheEntry(entry)).toBe(true);
        expect(
            isCompatibleMaiaCacheEntry({
                ...entry,
                modelVersion: 'stale-model',
            })
        ).toBe(false);
        expect(
            isCompatibleMaiaCacheEntry({
                ...entry,
                sha256: '0'.repeat(64),
            })
        ).toBe(false);
        expect(
            isCompatibleMaiaCacheEntry({
                ...entry,
                bytes: new ArrayBuffer(8),
            })
        ).toBe(false);
    });
});
