import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrainingPromptDto } from '@/lib/training/api';
import {
    INITIAL_PRACTICE_MAX_PAGE_HOPS,
    loadInitialPracticeFeed,
    requestedInitialPracticeFilters,
} from '@/app/(app)/practice/initialPracticeFeed';
import {
    getTrainingMomentPrompt,
    listPracticeFeed,
} from '@/lib/training/readService';

vi.mock('@/lib/training/readService', () => ({
    getTrainingMomentPrompt: vi.fn(),
    listPracticeFeed: vi.fn(),
}));

const getMomentMock = vi.mocked(getTrainingMomentPrompt);
const listFeedMock = vi.mocked(listPracticeFeed);

function prompt(id: string): TrainingPromptDto {
    return {
        id,
        solutionRevisionId: `revision-${id}`,
        fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
        sideToMove: 'w',
        grading: {} as TrainingPromptDto['grading'],
        review: {} as TrainingPromptDto['review'],
    };
}

describe('server-rendered initial Practice feed', () => {
    beforeEach(() => {
        getMomentMock.mockReset();
        listFeedMock.mockReset();
    });

    it('builds explicit mode and game filters without hidden defaults', () => {
        expect(
            requestedInitialPracticeFilters({
                mode: 'REVIEW',
                gameId: 'game-1',
            })
        ).toEqual({ mode: 'REVIEW', gameId: 'game-1' });
        expect(requestedInitialPracticeFilters({})).toEqual({});
    });

    it('returns a deep-linked prompt without starting or skipping the feed', async () => {
        const initial = prompt('moment-1');
        getMomentMock.mockResolvedValue({ moment: initial });
        const db = {
            trainingMoment: {},
            user: { findUnique: vi.fn() },
        };

        await expect(
            loadInitialPracticeFeed({
                db: db as never,
                userId: 'user-1',
                momentId: initial.id,
                mode: 'NEW',
            })
        ).resolves.toEqual({
            ownerId: 'user-1',
            prompt: initial,
            nextCursor: null,
            appliedFilters: {},
            feedStarted: false,
            feedHadPositions: true,
            loadError: null,
        });
        expect(listFeedMock).not.toHaveBeenCalled();
        expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('renders one default prompt and hands its exact continuation to idle fill', async () => {
        const initial = prompt('moment-1');
        const findUnique = vi.fn().mockResolvedValue({
            preferences: { trainingSessionMix: 'MY_MISTAKES' },
        });
        listFeedMock.mockResolvedValue({
            items: [initial],
            nextCursor: 'after-initial',
            appliedFilters: {
                mode: 'REVIEW',
                sourceKinds: ['MY_MISTAKE'],
            },
        });

        const result = await loadInitialPracticeFeed({
            db: {
                trainingMoment: {},
                user: { findUnique },
            } as never,
            userId: 'user-1',
            mode: 'REVIEW',
        });

        expect(listFeedMock).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                request: {
                    limit: 1,
                    cursor: undefined,
                    filters: {
                        mode: 'REVIEW',
                        sourceKinds: ['MY_MISTAKE'],
                    },
                },
            })
        );
        expect(result).toEqual({
            ownerId: 'user-1',
            prompt: initial,
            nextCursor: 'after-initial',
            appliedFilters: {
                mode: 'REVIEW',
                sourceKinds: ['MY_MISTAKE'],
            },
            feedStarted: true,
            feedHadPositions: true,
            loadError: null,
        });
    });

    it('does not read saved mix for a game-scoped feed and reports exhaustion without loading', async () => {
        const findUnique = vi.fn();
        listFeedMock.mockResolvedValue({
            items: [],
            nextCursor: null,
            appliedFilters: { gameId: 'game-1', mode: 'NEW' },
        });

        const result = await loadInitialPracticeFeed({
            db: {
                trainingMoment: {},
                user: { findUnique },
            } as never,
            userId: 'user-1',
            gameId: 'game-1',
            mode: 'NEW',
        });

        expect(findUnique).not.toHaveBeenCalled();
        expect(result.prompt).toBeNull();
        expect(result.feedStarted).toBe(true);
        expect(result.nextCursor).toBeNull();
        expect(result.feedHadPositions).toBe(false);
    });

    it('walks an empty stale page without skipping the first usable prompt', async () => {
        const initial = prompt('moment-2');
        listFeedMock
            .mockResolvedValueOnce({
                items: [],
                nextCursor: 'past-stale',
                appliedFilters: {},
            })
            .mockResolvedValueOnce({
                items: [initial],
                nextCursor: 'after-initial',
                appliedFilters: {},
            });

        const result = await loadInitialPracticeFeed({
            db: {
                trainingMoment: {},
                user: {
                    findUnique: vi.fn().mockResolvedValue(null),
                },
            } as never,
            userId: 'user-1',
        });

        expect(listFeedMock.mock.calls.map((call) => call[0].request)).toEqual([
            { limit: 1, cursor: undefined, filters: {} },
            { limit: 1, cursor: 'past-stale', filters: {} },
        ]);
        expect(result.prompt?.id).toBe(initial.id);
        expect(result.nextCursor).toBe('after-initial');
    });

    it('hands a long stale scan to the post-paint client after a bounded number of reads', async () => {
        listFeedMock
            .mockResolvedValueOnce({
                items: [],
                nextCursor: 'past-stale-1',
                appliedFilters: { mode: 'REVIEW' },
            })
            .mockResolvedValueOnce({
                items: [],
                nextCursor: 'past-stale-2',
                appliedFilters: { mode: 'REVIEW' },
            });

        const result = await loadInitialPracticeFeed({
            db: {
                trainingMoment: {},
                user: { findUnique: vi.fn().mockResolvedValue(null) },
            } as never,
            userId: 'user-1',
            mode: 'REVIEW',
        });

        expect(listFeedMock).toHaveBeenCalledTimes(
            INITIAL_PRACTICE_MAX_PAGE_HOPS
        );
        expect(result).toEqual({
            ownerId: 'user-1',
            prompt: null,
            nextCursor: 'past-stale-2',
            appliedFilters: { mode: 'REVIEW' },
            feedStarted: true,
            feedHadPositions: false,
            loadError: null,
        });
    });
});
