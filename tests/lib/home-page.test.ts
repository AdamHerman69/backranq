import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRequestSessionMock, readSnapshotMock, redirectMock } = vi.hoisted(
    () => ({
        getRequestSessionMock: vi.fn(),
        readSnapshotMock: vi.fn(),
        redirectMock: vi.fn(),
    })
);

vi.mock('@/lib/auth/requestSession', () => ({
    getRequestSession: getRequestSessionMock,
}));
vi.mock('@/lib/home/readService', () => ({
    readHomeDashboardSnapshot: readSnapshotMock,
}));
vi.mock('next/navigation', () => ({
    redirect: redirectMock,
}));

import HomePage from '@/app/(app)/home/page';

describe('Home page server bootstrap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('redirects before dashboard reads when the request has no owner', async () => {
        getRequestSessionMock.mockResolvedValue(null);
        redirectMock.mockImplementation(() => {
            throw new Error('NEXT_REDIRECT');
        });

        await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT');

        expect(redirectMock).toHaveBeenCalledWith(
            '/login?callbackUrl=/home'
        );
        expect(readSnapshotMock).not.toHaveBeenCalled();
    });

    it('passes the authenticated viewer and server snapshot into the first render', async () => {
        getRequestSessionMock.mockResolvedValue({
            user: { id: 'owner-1', name: 'Ada Lovelace' },
        });
        const snapshot = Object.freeze({
            ownerId: 'owner-1',
            generatedAt: '2026-08-23T12:00:00.000Z',
            status: 'ready',
        });
        readSnapshotMock.mockResolvedValue(snapshot);

        const result = await HomePage();

        expect(readSnapshotMock).toHaveBeenCalledOnce();
        expect(readSnapshotMock).toHaveBeenCalledWith('owner-1');
        expect(result.props.viewer).toEqual({
            id: 'owner-1',
            name: 'Ada Lovelace',
        });
        expect(result.props.snapshot).toBe(snapshot);
    });

    it('keeps the client Home bootstrap free of mount-time API waterfalls', () => {
        const dashboardSource = readFileSync(
            'src/app/(app)/home/HomeDashboard.tsx',
            'utf8'
        );
        const syncWidgetSource = readFileSync(
            'src/components/sync/SyncGamesWidget.tsx',
            'utf8'
        );

        expect(dashboardSource).not.toContain('/api/training/due');
        expect(dashboardSource).not.toContain('/api/games?');
        expect(dashboardSource).not.toContain('getSyncStatus');
        expect(dashboardSource).not.toContain('useSession');
        expect(dashboardSource).toContain('router.refresh()');
        expect(syncWidgetSource).toContain(
            'if (initialOwnerId === ownerId) return;'
        );
    });
});
