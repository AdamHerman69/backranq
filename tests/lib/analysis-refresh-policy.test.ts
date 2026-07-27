import { describe, expect, it } from 'vitest';
import { shouldPollAnalysis } from '@/lib/analysis/analysisRefreshPolicy';

describe('analysis refresh policy', () => {
    it('polls a tracked same-tab server batch without a linked provider', () => {
        expect(
            shouldPollAnalysis({
                authenticated: true,
                ownerId: 'owner-a',
                hasLinkedAccount: false,
                hasTrackedServerBatch: true,
                serverQueued: 0,
                serverRunning: 0,
                browserRunning: false,
            })
        ).toBe(true);
    });

    it('does not poll another owner after logout', () => {
        expect(
            shouldPollAnalysis({
                authenticated: false,
                ownerId: null,
                hasLinkedAccount: false,
                hasTrackedServerBatch: true,
                serverQueued: 1,
                serverRunning: 0,
                browserRunning: false,
            })
        ).toBe(false);
    });
});
