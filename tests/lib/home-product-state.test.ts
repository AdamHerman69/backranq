import { describe, expect, it } from 'vitest';
import {
    deriveHomeProductState,
    type HomeStateInput,
} from '@/lib/product/homeState';

function input(overrides: Partial<HomeStateInput> = {}): HomeStateInput {
    return {
        loading: false,
        error: null,
        linkedAccountKnown: true,
        hasLinkedAccount: true,
        gameCount: 4,
        unanalyzedGameCount: 0,
        trainingMomentCount: 3,
        browserAnalysisRunning: false,
        serverQueued: 0,
        serverRunning: 0,
        serverFailed: 0,
        analysisBlockedReason: null,
        lastCompletion: null,
        ...overrides,
    };
}

describe('home product state', () => {
    it('does not collapse loading or errors into an empty library', () => {
        expect(
            deriveHomeProductState(
                input({
                    loading: true,
                    gameCount: 0,
                    trainingMomentCount: 0,
                })
            )
        ).toBe('loading');
        expect(
            deriveHomeProductState(
                input({
                    error: 'network down',
                    gameCount: 0,
                    trainingMomentCount: 0,
                })
            )
        ).toBe('error');
    });

    it('separates onboarding, pending analysis and active analysis', () => {
        expect(
            deriveHomeProductState(
                input({
                    hasLinkedAccount: false,
                    gameCount: 0,
                    trainingMomentCount: 0,
                })
            )
        ).toBe('no-linked-account');
        expect(
            deriveHomeProductState(
                input({ gameCount: 0, trainingMomentCount: 0 })
            )
        ).toBe('no-games');
        expect(
            deriveHomeProductState(
                input({ unanalyzedGameCount: 2, trainingMomentCount: 0 })
            )
        ).toBe('unanalyzed');
        expect(
            deriveHomeProductState(
                input({
                    unanalyzedGameCount: 2,
                    trainingMomentCount: 0,
                    serverRunning: 1,
                })
            )
        ).toBe('analysis-in-progress');
    });

    it('keeps existing training moments usable without a linked provider', () => {
        expect(
            deriveHomeProductState(
                input({ hasLinkedAccount: false, trainingMomentCount: 3 })
            )
        ).toBe('analyzed-with-training-moments');
    });

    it('does not claim an account is unlinked when source status is unknown', () => {
        expect(
            deriveHomeProductState(
                input({
                    linkedAccountKnown: false,
                    hasLinkedAccount: false,
                    gameCount: 0,
                    trainingMomentCount: 0,
                })
            )
        ).toBe('sync-status-unavailable');
    });

    it('distinguishes generated moments from a successful no-candidate run', () => {
        expect(deriveHomeProductState(input({ trainingMomentCount: 2 }))).toBe(
            'analyzed-with-training-moments'
        );
        expect(deriveHomeProductState(input({ trainingMomentCount: 0 }))).toBe(
            'analyzed-no-candidates'
        );
    });

    it('keeps Practice dominant while more games wait or analyze', () => {
        expect(
            deriveHomeProductState(
                input({
                    trainingMomentCount: 2,
                    unanalyzedGameCount: 8,
                    serverRunning: 1,
                    analysisBlockedReason: 'No credits',
                })
            )
        ).toBe('analyzed-with-training-moments');
    });

    it('keeps available Practice dominant when a secondary overview refresh fails', () => {
        expect(
            deriveHomeProductState(
                input({
                    error: 'sync status unavailable',
                    trainingMomentCount: 2,
                })
            )
        ).toBe('analyzed-with-training-moments');
    });

    it('distinguishes an analysis backlog blocked by credits or caps', () => {
        expect(
            deriveHomeProductState(
                input({
                    trainingMomentCount: 0,
                    unanalyzedGameCount: 3,
                    analysisBlockedReason: 'Daily cap reached',
                })
            )
        ).toBe('analysis-blocked');
    });

    it('surfaces a partial terminal run while unfinished games remain', () => {
        expect(
            deriveHomeProductState(
                input({
                    unanalyzedGameCount: 1,
                    trainingMomentCount: 0,
                    lastCompletion: {
                        id: 'summary',
                        ownerId: 'user-a',
                        source: 'server',
                        status: 'partial',
                        requested: 2,
                        succeeded: 1,
                        failed: 1,
                        trainingMomentsGenerated: 1,
                        pendingAtCompletion: 1,
                        completedAt: '2026-07-27T00:00:00.000Z',
                    },
                })
            )
        ).toBe('failed');
    });

    it('ignores an old partial completion after new games are imported', () => {
        expect(
            deriveHomeProductState(
                input({
                    unanalyzedGameCount: 3,
                    trainingMomentCount: 0,
                    lastCompletion: {
                        id: 'old-summary',
                        ownerId: 'user-a',
                        source: 'server',
                        status: 'partial',
                        requested: 2,
                        succeeded: 1,
                        failed: 1,
                        trainingMomentsGenerated: 1,
                        pendingAtCompletion: 1,
                        completedAt: '2026-07-27T00:00:00.000Z',
                    },
                })
            )
        ).toBe('unanalyzed');
    });
});
