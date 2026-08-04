import { describe, expect, it } from 'vitest';
import {
    addUtcMonthsClamped,
    nextMonthlyRenewAt,
} from '@/lib/billing/periods';

describe('billing periods', () => {
    it.each([
        ['2026-01-31T12:34:56.789Z', '2026-02-28T12:34:56.789Z'],
        ['2024-01-31T12:34:56.789Z', '2024-02-29T12:34:56.789Z'],
        ['2026-03-31T12:34:56.789Z', '2026-04-30T12:34:56.789Z'],
        ['2026-05-30T12:34:56.789Z', '2026-06-30T12:34:56.789Z'],
    ])('clamps %s to the last valid target-month day', (source, expected) => {
        expect(nextMonthlyRenewAt(new Date(source)).toISOString()).toBe(
            expected
        );
    });

    it('supports a clamped reverse shift without overflowing into March', () => {
        expect(
            addUtcMonthsClamped(
                new Date('2026-03-31T12:34:56.789Z'),
                -1
            ).toISOString()
        ).toBe('2026-02-28T12:34:56.789Z');
    });
});
