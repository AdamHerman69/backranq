import { afterEach, describe, expect, it } from 'vitest';
import { notificationCopy } from '@/lib/notifications/contracts';
import { practiceReadyDeliveryWindow } from '@/lib/notifications/scheduling';
import {
    createUnsubscribeToken,
    verifyUnsubscribeToken,
} from '@/lib/notifications/tokens';

describe('notification contracts', () => {
    afterEach(() => {
        delete process.env.NOTIFICATION_UNSUBSCRIBE_SECRET;
    });

    it('renders aggregate practice counts with correct grammar', () => {
        expect(
            notificationCopy({
                type: 'PRACTICE_READY',
                title: 'stale',
                body: 'stale',
                itemCount: 8,
                secondaryCount: 3,
            })
        ).toEqual({
            title: 'Your new practice is ready',
            body: '8 practice positions from 3 analyzed games are ready.',
        });
    });

    it('renders the current due snapshot rather than an accumulated count', () => {
        expect(
            notificationCopy({
                type: 'PRACTICE_DUE',
                title: 'stale',
                body: 'stale',
                itemCount: 1,
                secondaryCount: 0,
            })
        ).toEqual({
            title: 'Your practice review is due',
            body: '1 practice position is ready for review.',
        });
    });

    it('marks a capped due snapshot as a lower bound', () => {
        expect(
            notificationCopy({
                type: 'PRACTICE_DUE',
                title: 'stale',
                body: 'stale',
                itemCount: 100,
                secondaryCount: 0,
                metadata: { dueCountIsExact: false },
            })
        ).toEqual({
            title: 'Your practice review is due',
            body: '100+ practice positions are ready for review.',
        });
    });

    it('groups practice created before the same local digest into one delivery', () => {
        const first = practiceReadyDeliveryWindow(
            new Date('2026-08-04T06:00:00.000Z'),
            'Europe/Prague',
            9
        );
        const second = practiceReadyDeliveryWindow(
            new Date('2026-08-04T06:55:00.000Z'),
            'Europe/Prague',
            9
        );

        expect(first).toEqual(second);
        expect(first.scheduledFor.toISOString()).toBe(
            '2026-08-04T07:00:00.000Z'
        );
    });

    it('starts the next daily practice delivery after the local digest hour', () => {
        const window = practiceReadyDeliveryWindow(
            new Date('2026-08-04T07:01:00.000Z'),
            'Europe/Prague',
            9
        );

        expect(window.scheduledFor.toISOString()).toBe(
            '2026-08-05T07:00:00.000Z'
        );
    });

    it('moves a nonexistent DST-gap digest hour to the first valid instant', () => {
        const window = practiceReadyDeliveryWindow(
            new Date('2026-03-28T12:00:00.000Z'),
            'Europe/Prague',
            2
        );

        expect(window.scheduledFor.toISOString()).toBe(
            '2026-03-29T01:00:00.000Z'
        );
    });

    it('chooses one stable instant for a repeated DST-fold digest hour', () => {
        const window = practiceReadyDeliveryWindow(
            new Date('2026-10-24T12:00:00.000Z'),
            'Europe/Prague',
            2
        );

        expect(window.scheduledFor.toISOString()).toBe(
            '2026-10-25T01:00:00.000Z'
        );
    });

    it('signs and validates unsubscribe tokens without exposing the secret', () => {
        process.env.NOTIFICATION_UNSUBSCRIBE_SECRET = 'test-secret';
        const userId = '00000000-0000-4000-8000-000000000001';
        const token = createUnsubscribeToken(userId);

        expect(token).not.toContain('test-secret');
        expect(verifyUnsubscribeToken(token)).toBe(userId);
        expect(verifyUnsubscribeToken(`${token}tampered`)).toBeNull();
    });
});
