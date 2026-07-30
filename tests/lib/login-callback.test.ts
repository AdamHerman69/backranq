import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, redirectMock, signInButtonMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    redirectMock: vi.fn(),
    signInButtonMock: vi.fn<
        (props: { callbackUrl?: string }) => null
    >(() => null),
}));

vi.mock('@/lib/auth', () => ({
    auth: authMock,
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
}));

vi.mock('@/lib/auth/config', () => ({
    AUTH_PROVIDER_UI: [
        { id: 'google', label: 'Google', enabled: true },
        { id: 'lichess', label: 'Lichess', enabled: true },
    ],
}));

vi.mock('@/components/auth/SignInButton', () => ({
    SignInButton: signInButtonMock,
}));

import LoginPage from '@/app/login/page';

describe('login callback handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('defaults direct sign-in to Home for every provider', async () => {
        authMock.mockResolvedValue(null);

        renderToStaticMarkup(
            await LoginPage({ searchParams: Promise.resolve({}) })
        );

        expect(signInButtonMock).toHaveBeenCalledTimes(2);
        expect(
            signInButtonMock.mock.calls.map(
                ([props]) => props.callbackUrl
            )
        ).toEqual(['/home', '/home']);
    });

    it('passes a valid relative callback to every provider', async () => {
        const callbackUrl =
            '/practice?momentId=11111111-1111-4111-8111-111111111111';
        authMock.mockResolvedValue(null);

        renderToStaticMarkup(
            await LoginPage({
                searchParams: Promise.resolve({ callbackUrl }),
            })
        );

        expect(
            signInButtonMock.mock.calls.map(
                ([props]) => props.callbackUrl
            )
        ).toEqual([callbackUrl, callbackUrl]);
    });

    it('replaces an unsafe provider callback with Home', async () => {
        authMock.mockResolvedValue(null);

        renderToStaticMarkup(
            await LoginPage({
                searchParams: Promise.resolve({
                    callbackUrl: 'https://attacker.test',
                }),
            })
        );

        expect(
            signInButtonMock.mock.calls.map(
                ([props]) => props.callbackUrl
            )
        ).toEqual(['/home', '/home']);
    });

    it.each([
        '//attacker.test',
        '/.//attacker.test',
        '/safe/..//attacker.test',
        '/%2e%2e//attacker.test',
    ])(
        'redirects an authenticated user away from unsafe callback %s',
        async (callbackUrl) => {
            authMock.mockResolvedValue({ user: { id: 'user-1' } });
            redirectMock.mockImplementation(() => {
                throw new Error('NEXT_REDIRECT');
            });

            await expect(
                LoginPage({
                    searchParams: Promise.resolve({
                        callbackUrl,
                    }),
                })
            ).rejects.toThrow('NEXT_REDIRECT');
            expect(redirectMock).toHaveBeenCalledWith('/home');
        }
    );

    it('preserves a valid callback for an authenticated user', async () => {
        authMock.mockResolvedValue({ user: { id: 'user-1' } });
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            LoginPage({
                searchParams: Promise.resolve({
                    callbackUrl: '/practice',
                }),
            })
        ).rejects.toThrow('NEXT_REDIRECT');
        expect(redirectMock).toHaveBeenCalledWith('/practice');
    });
});
