import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearCoachOfflineOwner,
    COACH_OFFLINE_OWNER_STORAGE_KEY,
    getRememberedCoachOwnerId,
    resolveCoachOwnerId,
} from '@/lib/coach/offlineOwner';

function localStorageDouble() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => {
            values.delete(key);
        },
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

describe('coach offline owner alias', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('recovers the authenticated namespace in the static offline shell', () => {
        const localStorage = localStorageDouble();
        vi.stubGlobal('window', { localStorage });

        expect(resolveCoachOwnerId('user-1')).toBe('user-1');
        expect(getRememberedCoachOwnerId()).toBe('user-1');
        expect(
            localStorage.getItem(COACH_OFFLINE_OWNER_STORAGE_KEY)
        ).toBe('user-1');
        expect(resolveCoachOwnerId(null)).toBe('user-1');
    });

    it('removes the alias on explicit sign-out', () => {
        const localStorage = localStorageDouble();
        vi.stubGlobal('window', { localStorage });

        resolveCoachOwnerId('user-1');
        clearCoachOfflineOwner();

        expect(getRememberedCoachOwnerId()).toBeNull();
        expect(resolveCoachOwnerId(null)).toBe('local');
    });
});
