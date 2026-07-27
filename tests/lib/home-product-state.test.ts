import { describe, expect, it } from 'vitest';
import {
    deriveHomeProductState,
    type HomeStateInput,
} from '@/lib/product/homeState';

function input(overrides: Partial<HomeStateInput> = {}): HomeStateInput {
    return {
        loading: false,
        error: null,
        hasLinkedAccount: true,
        gameCount: 4,
        unanalyzedGameCount: 0,
        puzzleCount: 3,
        browserAnalysisRunning: false,
        serverQueued: 0,
        serverRunning: 0,
        lastCompletion: null,
        ...overrides,
    };
}

describe('home product state', () => {
    it('does not collapse loading or errors into an empty library', () => {
        expect(
            deriveHomeProductState(
                input({ loading: true, gameCount: 0, puzzleCount: 0 })
            )
        ).toBe('loading');
        expect(
            deriveHomeProductState(
                input({
                    error: 'network down',
                    gameCount: 0,
                    puzzleCount: 0,
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
                    puzzleCount: 0,
                })
            )
        ).toBe('no-linked-account');
        expect(
            deriveHomeProductState(input({ gameCount: 0, puzzleCount: 0 }))
        ).toBe('no-games');
        expect(
            deriveHomeProductState(input({ unanalyzedGameCount: 2 }))
        ).toBe('unanalyzed');
        expect(
            deriveHomeProductState(
                input({ unanalyzedGameCount: 2, serverRunning: 1 })
            )
        ).toBe('analysis-in-progress');
    });

    it('keeps an existing puzzle library trainable without a linked provider', () => {
        expect(
            deriveHomeProductState(
                input({ hasLinkedAccount: false, puzzleCount: 3 })
            )
        ).toBe('analyzed-with-puzzles');
    });

    it('distinguishes generated puzzles from a successful no-candidate run', () => {
        expect(deriveHomeProductState(input({ puzzleCount: 2 }))).toBe(
            'analyzed-with-puzzles'
        );
        expect(deriveHomeProductState(input({ puzzleCount: 0 }))).toBe(
            'analyzed-no-candidates'
        );
    });

    it('surfaces a partial terminal run while unfinished games remain', () => {
        expect(
            deriveHomeProductState(
                input({
                    unanalyzedGameCount: 1,
                    lastCompletion: {
                        id: 'summary',
                        ownerId: 'user-a',
                        source: 'server',
                        status: 'partial',
                        requested: 2,
                        succeeded: 1,
                        failed: 1,
                        puzzlesGenerated: 1,
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
                    lastCompletion: {
                        id: 'old-summary',
                        ownerId: 'user-a',
                        source: 'server',
                        status: 'partial',
                        requested: 2,
                        succeeded: 1,
                        failed: 1,
                        puzzlesGenerated: 1,
                        pendingAtCompletion: 1,
                        completedAt: '2026-07-27T00:00:00.000Z',
                    },
                })
            )
        ).toBe('unanalyzed');
    });
});
