import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, redirectMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    auth: authMock,
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
    usePathname: vi.fn(() => '/home'),
}));

import manifest from '@/app/manifest';
import PracticePage from '@/app/practice/page';
import { appNavItems } from '@/components/nav/AppNav';
import { config as proxyConfig } from '@/proxy';

describe('practice route information architecture', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('protects Home and Practice without retaining the legacy route', () => {
        expect(proxyConfig.matcher).toContain('/home/:path*');
        expect(proxyConfig.matcher).toContain('/practice/:path*');
        expect(proxyConfig.matcher).not.toContain('/training/:path*');
        expect(existsSync('src/app/practice/page.tsx')).toBe(true);
        expect(existsSync('src/app/training/page.tsx')).toBe(false);
    });

    it('uses canonical Home and Practice destinations in app navigation', () => {
        const home = appNavItems.find((item) => item.label === 'Home');
        const practice = appNavItems.find(
            (item) => item.label === 'Practice'
        );

        expect(home?.href).toBe('/home');
        expect(home?.active?.('/home')).toBe(true);
        expect(home?.active?.('/practice')).toBe(false);
        expect(practice?.href).toBe('/practice');
        expect(practice?.active?.('/practice/deep-link')).toBe(true);
        expect(practice?.active?.('/training')).toBe(false);
    });

    it('returns unauthenticated users to the canonical Practice route', async () => {
        authMock.mockResolvedValue(null);
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            PracticePage({ searchParams: Promise.resolve({}) })
        ).rejects.toThrow('NEXT_REDIRECT');

        const target = new URL(
            redirectMock.mock.calls[0]?.[0] as string,
            'https://backranq.test'
        );
        expect(target.pathname).toBe('/login');
        expect(target.searchParams.get('callbackUrl')).toBe('/practice');
    });

    it('preserves a valid Practice deep link through server-side auth failure', async () => {
        const momentId = '11111111-1111-4111-8111-111111111111';
        authMock.mockResolvedValue(null);
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            PracticePage({
                searchParams: Promise.resolve({ momentId }),
            })
        ).rejects.toThrow('NEXT_REDIRECT');

        const target = new URL(
            redirectMock.mock.calls[0]?.[0] as string,
            'https://backranq.test'
        );
        expect(target.pathname).toBe('/login');
        expect(target.searchParams.get('callbackUrl')).toBe(
            `/practice?momentId=${momentId}`
        );
    });

    it('does not preserve an invalid Practice moment id', async () => {
        authMock.mockResolvedValue(null);
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            PracticePage({
                searchParams: Promise.resolve({
                    momentId: 'not-a-valid-moment-id',
                }),
            })
        ).rejects.toThrow('NEXT_REDIRECT');

        const target = new URL(
            redirectMock.mock.calls[0]?.[0] as string,
            'https://backranq.test'
        );
        expect(target.searchParams.get('callbackUrl')).toBe('/practice');
    });

    it('opens the installed app on Home', () => {
        expect(manifest().start_url).toBe('/home');
    });
});
