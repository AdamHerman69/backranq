import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearCoachOfflineAccess,
    COACH_OFFLINE_ACCESS_STORAGE_KEY,
    grantCoachOfflineAccess,
    hasCoachOfflineAccess,
} from '@/lib/coach/offlineAccess';

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

describe('coach offline access enrollment', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('only grants the enrolled authenticated owner', () => {
        const localStorage = localStorageDouble();
        vi.stubGlobal('window', { localStorage });

        grantCoachOfflineAccess('user-1');

        expect(hasCoachOfflineAccess('user-1')).toBe(true);
        expect(hasCoachOfflineAccess('user-2')).toBe(false);
        expect(hasCoachOfflineAccess(null)).toBe(false);
    });

    it('rejects malformed storage and clears enrollment on sign-out', () => {
        const localStorage = localStorageDouble();
        vi.stubGlobal('window', { localStorage });
        localStorage.setItem(
            COACH_OFFLINE_ACCESS_STORAGE_KEY,
            '{"version":1,"ownerId":"user-1"}'
        );

        expect(hasCoachOfflineAccess('user-1')).toBe(false);

        grantCoachOfflineAccess('user-1');
        clearCoachOfflineAccess();
        expect(hasCoachOfflineAccess('user-1')).toBe(false);
    });
});
