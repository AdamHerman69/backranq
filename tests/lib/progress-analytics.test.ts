import { describe, expect, it, vi } from 'vitest';
import {
    parseProgressAnalyticsWrite,
    recordProgressAnalyticsEvent,
} from '@/lib/progress/analytics';

const now = new Date('2026-07-30T12:00:00.000Z');
const clientEventId = '10000000-0000-4000-8000-000000000001';

describe('Progress analytics writes', () => {
    it('accepts only the typed allowlisted vocabulary', () => {
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'ACTION_CLICKED',
                    clientEventId,
                    occurredAt: now.toISOString(),
                    actionKey: 'primary-next-action',
                    recommendationKey: 'mixed-practice',
                    windowDays: 28,
                    provider: 'LICHESS',
                    timeClass: 'RAPID',
                },
                now
            )
        ).not.toBeNull();
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'ACTION_CLICKED',
                    clientEventId,
                    occurredAt: now.toISOString(),
                    actionKey: 'arbitrary-user-value',
                },
                now
            )
        ).toBeNull();
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId,
                    occurredAt: now.toISOString(),
                    payload: { fen: 'must never be accepted' },
                },
                now
            )
        ).toBeNull();
    });

    it('rejects malformed IDs and timestamps outside the skew window', () => {
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId: 'not-a-uuid',
                    occurredAt: now.toISOString(),
                },
                now
            )
        ).toBeNull();
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId,
                    occurredAt: new Date(
                        now.getTime() + 6 * 60_000
                    ).toISOString(),
                },
                now
            )
        ).toBeNull();
        expect(
            parseProgressAnalyticsWrite(
                {
                    eventName: 'PROGRESS_VIEWED',
                    clientEventId,
                    occurredAt: new Date(
                        now.getTime() - 8 * 24 * 60 * 60_000
                    ).toISOString(),
                },
                now
            )
        ).toBeNull();
    });

    it('persists only typed scalar columns', async () => {
        const queryRaw = vi
            .fn()
            .mockResolvedValue([{ eventCount: 1 }]);
        const create = vi.fn().mockResolvedValue({ id: 'event-1' });
        const event = parseProgressAnalyticsWrite(
            {
                eventName: 'INSIGHT_EXPANDED',
                clientEventId,
                occurredAt: now.toISOString(),
                insightKey: 'review-retention',
                windowDays: 90,
            },
            now
        );
        expect(event).not.toBeNull();

        await recordProgressAnalyticsEvent({
            db: {
                $queryRaw: queryRaw,
                progressAnalyticsEvent: {
                    create,
                },
            } as never,
            userId: 'user-1',
            event: event!,
        });

        expect(create).toHaveBeenCalledWith({
            data: {
                userId: 'user-1',
                clientEventId,
                eventName: 'INSIGHT_EXPANDED',
                occurredAt: now,
                windowDays: 90,
                provider: null,
                timeClass: null,
                insightKey: 'review-retention',
                actionKey: null,
                recommendationKey: null,
            },
        });
        expect(queryRaw).toHaveBeenCalledOnce();
    });

    it('drops excess per-user events before they can grow storage', async () => {
        const create = vi.fn();
        const result = await recordProgressAnalyticsEvent({
            db: {
                $queryRaw: vi.fn().mockResolvedValue([]),
                progressAnalyticsEvent: {
                    create,
                },
            } as never,
            userId: 'user-1',
            event: {
                eventName: 'PROGRESS_VIEWED',
                clientEventId,
                occurredAt: now.toISOString(),
            },
            now,
        });

        expect(result).toEqual({
            recorded: false,
            duplicate: false,
            rateLimited: true,
        });
        expect(create).not.toHaveBeenCalled();
    });
});
