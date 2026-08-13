import { describe, expect, it } from 'vitest';

import { canSavePracticeMix } from '@/components/settings/PracticeDefaultsCard';

describe('default position mix save state', () => {
    const readyState = {
        busy: false,
        loadError: null,
        loading: false,
        mix: 'MY_MISTAKES' as const,
        ownerReady: true,
        savedMix: 'ALL' as const,
    };

    it('allows saving only after a successfully loaded value changed', () => {
        expect(canSavePracticeMix(readyState)).toBe(true);
        expect(
            canSavePracticeMix({
                ...readyState,
                mix: readyState.savedMix,
            })
        ).toBe(false);
        expect(
            canSavePracticeMix({ ...readyState, savedMix: null })
        ).toBe(false);
    });

    it('prevents saving during requests or after a load failure', () => {
        expect(
            canSavePracticeMix({ ...readyState, loading: true })
        ).toBe(false);
        expect(
            canSavePracticeMix({ ...readyState, busy: true })
        ).toBe(false);
        expect(
            canSavePracticeMix({
                ...readyState,
                loadError: 'Unavailable',
            })
        ).toBe(false);
        expect(
            canSavePracticeMix({ ...readyState, ownerReady: false })
        ).toBe(false);
    });
});
