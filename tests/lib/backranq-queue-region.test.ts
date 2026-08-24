import { describe, expect, it } from 'vitest';
import {
    backranqQueueRegion,
    configuredBackranqQueueRegion,
    isVercelRegionCode,
} from '@/lib/queues/region';

describe('Backranq Queue region', () => {
    it('requires Queue and Function execution to stay in one region', () => {
        expect(() =>
            backranqQueueRegion({
                BACKRANQ_QUEUE_REGION: 'dub1',
                VERCEL_REGION: 'iad1',
            })
        ).toThrow('must match VERCEL_REGION');
        expect(
            backranqQueueRegion({ BACKRANQ_QUEUE_REGION: 'dub1' })
        ).toBe('dub1');
        expect(backranqQueueRegion({})).toBe('dub1');
    });

    it('fails fast when a Vercel environment has no explicit queue region', () => {
        expect(() =>
            backranqQueueRegion({ VERCEL_ENV: 'production' })
        ).toThrow('BACKRANQ_QUEUE_REGION is required');
        expect(() =>
            backranqQueueRegion({
                VERCEL_ENV: 'preview',
                BACKRANQ_QUEUE_REGION: 'eu-west-1',
            })
        ).toThrow('must be an explicit Vercel region code');
    });

    it('normalizes valid region codes and rejects malformed values', () => {
        expect(
            configuredBackranqQueueRegion({
                BACKRANQ_QUEUE_REGION: ' DUB1 ',
            })
        ).toBe('dub1');
        expect(
            configuredBackranqQueueRegion({
                BACKRANQ_QUEUE_REGION: 'eu-west-1',
            })
        ).toBeNull();
        expect(isVercelRegionCode('iad1')).toBe(true);
        expect(isVercelRegionCode('iad')).toBe(false);
    });
});
