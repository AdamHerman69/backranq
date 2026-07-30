import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    revokeAuthSession,
    signOutAndClearCoachSession,
} from '@/lib/coach/signOut';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe('coach sign-out ordering', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the tombstone final when another tab reloads during a delayed sign-out', async () => {
        const revocation = deferred<{ url: string }>();
        let serverSessionValid = true;
        let persistenceBlocked = false;
        let checkpointStored = true;
        const navigate = vi.fn();

        const operation = signOutAndClearCoachSession(
            'user-1',
            '/',
            {
                revokeSession: async () => {
                    const response = await revocation.promise;
                    serverSessionValid = false;
                    return response;
                },
                clearLocalSession: async () => {
                    persistenceBlocked = true;
                    checkpointStored = false;
                },
                navigate,
            }
        );

        // A second tab can still authenticate while revocation is pending.
        if (serverSessionValid) {
            persistenceBlocked = false;
            checkpointStored = true;
        }
        expect(persistenceBlocked).toBe(false);

        revocation.resolve({ url: '/' });
        await operation;

        // Once cleanup starts, no authenticated remount can clear its block.
        if (serverSessionValid) {
            persistenceBlocked = false;
            checkpointStored = true;
        }
        expect(serverSessionValid).toBe(false);
        expect(persistenceBlocked).toBe(true);
        expect(checkpointStored).toBe(false);
        expect(navigate).toHaveBeenCalledWith('/');
    });

    it('does not clear the local game when server revocation fails', async () => {
        const clearLocalSession = vi.fn();
        const navigate = vi.fn();

        await expect(
            signOutAndClearCoachSession('user-1', '/', {
                revokeSession: async () => {
                    throw new Error('network unavailable');
                },
                clearLocalSession,
                navigate,
            })
        ).rejects.toThrow('network unavailable');

        expect(clearLocalSession).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('rejects a resolved HTTP error before local data is cleared', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({ csrfToken: 'secure-token' }),
                        {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                            },
                        }
                    )
                )
                .mockResolvedValueOnce(
                    new Response(JSON.stringify({ url: '/' }), {
                        status: 500,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    })
                )
        );
        const clearLocalSession = vi.fn();
        const navigate = vi.fn();

        await expect(
            signOutAndClearCoachSession('user-1', '/', {
                revokeSession: revokeAuthSession,
                clearLocalSession,
                navigate,
            })
        ).rejects.toThrow('HTTP 500');

        expect(clearLocalSession).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('clears local data after a status-confirmed logout even with a malformed redirect payload', async () => {
        const clearLocalSession = vi.fn();
        const navigate = vi.fn();

        await signOutAndClearCoachSession('user-1', '/', {
            revokeSession: async () => ({ url: undefined }),
            clearLocalSession,
            navigate,
        });

        expect(clearLocalSession).toHaveBeenCalledWith('user-1');
        expect(navigate).toHaveBeenCalledWith('/');
    });

    it('clears local data when a successful logout response has malformed JSON', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({ csrfToken: 'secure-token' }),
                        {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                            },
                        }
                    )
                )
                .mockResolvedValueOnce(
                    new Response('{not-json', {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    })
                )
        );
        const clearLocalSession = vi.fn();
        const navigate = vi.fn();

        await signOutAndClearCoachSession('user-1', '/', {
            revokeSession: revokeAuthSession,
            clearLocalSession,
            navigate,
        });

        expect(clearLocalSession).toHaveBeenCalledWith('user-1');
        expect(navigate).toHaveBeenCalledWith('/');
    });
});
