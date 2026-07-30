import { MAIA_MODEL } from '@/lib/coach/maia/metadata';

export const MAIA_CACHE_DATABASE = 'backranq-maia';
export const MAIA_CACHE_VERSION = 1;
export const MAIA_CACHE_STORE = 'models';
export const MAIA_CACHE_KEY = `${MAIA_MODEL.id}:${MAIA_MODEL.version}:${MAIA_MODEL.sha256}`;

export type MaiaCachedModel = {
    key: string;
    modelId: string;
    modelVersion: string;
    sha256: string;
    byteLength: number;
    bytes: ArrayBuffer;
    cachedAt: number;
};

export function isCompatibleMaiaCacheEntry(
    value: unknown
): value is MaiaCachedModel {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<MaiaCachedModel>;
    return (
        entry.key === MAIA_CACHE_KEY &&
        entry.modelId === MAIA_MODEL.id &&
        entry.modelVersion === MAIA_MODEL.version &&
        entry.sha256 === MAIA_MODEL.sha256 &&
        entry.byteLength === MAIA_MODEL.byteLength &&
        entry.bytes instanceof ArrayBuffer &&
        entry.bytes.byteLength === MAIA_MODEL.byteLength &&
        typeof entry.cachedAt === 'number' &&
        Number.isFinite(entry.cachedAt)
    );
}
