import { describe, expect, it } from 'vitest';

import {
    notificationInboxReducer,
    type NotificationInboxState,
    type NotificationItem,
} from '@/components/notifications/NotificationBell';

const unread: NotificationItem = {
    id: 'notification-1',
    title: 'Ready',
    body: 'Your practice is ready.',
    href: '/practice',
    readAt: null,
    createdAt: '2026-08-13T00:00:00.000Z',
};

function state(): NotificationInboxState {
    return {
        items: [unread],
        unreadCount: 1,
        loading: false,
        loadError: false,
        writeError: null,
        writePending: false,
    };
}

describe('notification inbox state', () => {
    it('marks one unread item exactly once', () => {
        const first = notificationInboxReducer(state(), {
            type: 'MARK_ONE',
            id: unread.id,
            now: '2026-08-13T00:01:00.000Z',
        });
        const duplicate = notificationInboxReducer(first, {
            type: 'MARK_ONE',
            id: unread.id,
            now: '2026-08-13T00:02:00.000Z',
        });

        expect(first.unreadCount).toBe(0);
        expect(duplicate).toBe(first);
    });

    it('restores the exact snapshot when an optimistic write fails', () => {
        const snapshot = state();
        const optimistic = notificationInboxReducer(snapshot, {
            type: 'MARK_ALL',
            now: '2026-08-13T00:01:00.000Z',
        });
        const restored = notificationInboxReducer(optimistic, {
            type: 'RESTORE',
            snapshot,
            error: 'Could not mark notifications read',
        });

        expect(restored.items[0]?.readAt).toBeNull();
        expect(restored.unreadCount).toBe(1);
        expect(restored.writeError).toBe('Could not mark notifications read');
    });
});
