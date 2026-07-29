import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, getProgressSnapshotMock, redirectMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    getProgressSnapshotMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    auth: authMock,
}));

vi.mock('@/lib/progress/readService', () => ({
    getProgressSnapshot: getProgressSnapshotMock,
}));

vi.mock('next/navigation', () => ({
    redirect: redirectMock,
    usePathname: vi.fn(() => '/progress'),
}));

import ProgressPage from '@/app/progress/page';

describe('Progress page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('redirects signed-out users with the canonical filtered callback', async () => {
        authMock.mockResolvedValue(null);
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(
            ProgressPage({
                searchParams: Promise.resolve({
                    scope: '28',
                    provider: 'lichess',
                }),
            })
        ).rejects.toThrow('NEXT_REDIRECT');

        const target = new URL(
            redirectMock.mock.calls[0]?.[0] as string,
            'https://backranq.test'
        );
        expect(target.pathname).toBe('/login');
        expect(target.searchParams.get('callbackUrl')).toBe(
            '/progress?scope=28&provider=LICHESS'
        );
        expect(getProgressSnapshotMock).not.toHaveBeenCalled();
    });

    it('passes the authenticated owner and validated scope to the reader', async () => {
        authMock.mockResolvedValue({ user: { id: 'owner-1' } });
        const snapshot = { generatedAt: 'snapshot' };
        getProgressSnapshotMock.mockResolvedValue(snapshot);

        const result = await ProgressPage({
            searchParams: Promise.resolve({
                scope: 'all',
                provider: ['lichess', 'invalid'],
                timeClass: 'blitz',
            }),
        });

        expect(getProgressSnapshotMock).toHaveBeenCalledOnce();
        expect(getProgressSnapshotMock).toHaveBeenCalledWith({
            userId: 'owner-1',
            scope: 'all',
            asOf: expect.any(Date),
            filters: {
                providers: ['LICHESS'],
                timeClasses: ['BLITZ'],
            },
        });
        expect(result.props.snapshot).toBe(snapshot);
    });
});
