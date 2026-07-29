import { describe, expect, it } from 'vitest';

import { canSaveTrainingSessionMix } from '@/components/settings/TrainingSessionSettingsCard';

describe('training session settings save state', () => {
    const readyState = {
        busy: false,
        loadError: null,
        loading: false,
        mix: 'MY_MISTAKES' as const,
        savedMix: 'ALL' as const,
    };

    it('allows saving only after a successfully loaded value changed', () => {
        expect(canSaveTrainingSessionMix(readyState)).toBe(true);
        expect(
            canSaveTrainingSessionMix({
                ...readyState,
                mix: readyState.savedMix,
            })
        ).toBe(false);
        expect(
            canSaveTrainingSessionMix({ ...readyState, savedMix: null })
        ).toBe(false);
    });

    it('prevents saving during requests or after a load failure', () => {
        expect(
            canSaveTrainingSessionMix({ ...readyState, loading: true })
        ).toBe(false);
        expect(
            canSaveTrainingSessionMix({ ...readyState, busy: true })
        ).toBe(false);
        expect(
            canSaveTrainingSessionMix({
                ...readyState,
                loadError: 'Unavailable',
            })
        ).toBe(false);
    });
});
