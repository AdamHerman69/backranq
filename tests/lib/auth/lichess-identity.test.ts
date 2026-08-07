import { describe, expect, it, vi } from 'vitest';
import { syncVerifiedLichessIdentity } from '@/lib/auth/lichessIdentity';

describe('verified Lichess sign-in onboarding', () => {
    it('persists a separate verified connection before starting sync', async () => {
        const persistConnection = vi.fn(async () => undefined);
        const startFirstSync = vi.fn(async () => undefined);

        await expect(
            syncVerifiedLichessIdentity(
                {
                    user: { id: 'user-1' },
                    account: {
                        provider: 'lichess',
                        type: 'oauth',
                        providerAccountId: 'stable-id',
                    },
                    profile: { id: 'stable-id', username: 'VerifiedAda' },
                },
                { persistConnection, startFirstSync }
            )
        ).resolves.toBe(true);

        expect(persistConnection).toHaveBeenCalledWith({
            userId: 'user-1',
            providerAccountId: 'stable-id',
            username: 'VerifiedAda',
            usernameNormalized: 'verifiedada',
        });
        expect(persistConnection.mock.invocationCallOrder[0]).toBeLessThan(
            startFirstSync.mock.invocationCallOrder[0]!
        );
    });

    it('rejects a profile not bound to the authenticated account id', async () => {
        const persistConnection = vi.fn(async () => undefined);
        const startFirstSync = vi.fn(async () => undefined);
        await expect(
            syncVerifiedLichessIdentity(
                {
                    user: { id: 'user-1' },
                    account: {
                        provider: 'lichess',
                        type: 'oauth',
                        providerAccountId: 'stable-id',
                    },
                    profile: { id: 'other-id', username: 'Ada' },
                },
                { persistConnection, startFirstSync }
            )
        ).rejects.toThrow(/incomplete/i);
        expect(persistConnection).not.toHaveBeenCalled();
    });
});
