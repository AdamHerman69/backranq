import { describe, expect, it } from 'vitest';

import type { TrainingPromptDto } from '@/lib/training/api';
import {
    PRACTICE_FEED_LOW_WATER_MARK,
    practiceFeedLoadErrorAfterEvent,
    practiceFeedOnlineAfterRead,
    practicePromptKey,
    isPracticeOwnerRunCurrent,
    resolvePracticeOwnerId,
    shouldPrefetchPracticeFeed,
    unseenPracticePrompts,
} from '@/lib/hooks/usePracticeFeed';
import { trainingQueueStorageKey } from '@/lib/training/offlineQueue';

function prompt(
    id: string,
    solutionRevisionId = `revision-${id}`
): TrainingPromptDto {
    return {
        id,
        solutionRevisionId,
        fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
        sideToMove: 'w',
        grading: {} as TrainingPromptDto['grading'],
    };
}

describe('proactive practice feed buffering', () => {
    it('deduplicates by moment and pinned solution revision across and within pages', () => {
        const firstRevision = prompt('moment-1', 'revision-1');
        const changedRevision = prompt('moment-1', 'revision-2');
        const seen = new Set([practicePromptKey(firstRevision)]);

        expect(
            unseenPracticePrompts(
                [
                    firstRevision,
                    changedRevision,
                    changedRevision,
                    prompt('moment-2'),
                ],
                seen
            ).map(practicePromptKey)
        ).toEqual([
            'moment-1:revision-2',
            'moment-2:revision-moment-2',
        ]);
    });

    it('prefetches at the low-water boundary but not offline or after exhaustion', () => {
        expect(
            shouldPrefetchPracticeFeed({
                bufferedPositions: PRACTICE_FEED_LOW_WATER_MARK + 1,
                feedStarted: true,
                feedExhausted: false,
                online: true,
            })
        ).toBe(false);
        expect(
            shouldPrefetchPracticeFeed({
                bufferedPositions: PRACTICE_FEED_LOW_WATER_MARK,
                feedStarted: true,
                feedExhausted: false,
                online: true,
            })
        ).toBe(true);
        expect(
            shouldPrefetchPracticeFeed({
                bufferedPositions: 0,
                feedStarted: true,
                feedExhausted: true,
                online: true,
            })
        ).toBe(false);
        expect(
            shouldPrefetchPracticeFeed({
                bufferedPositions: 0,
                feedStarted: true,
                feedExhausted: false,
                online: false,
            })
        ).toBe(false);
    });
});

describe('practice feed read recovery', () => {
    it('does not treat a read TypeError as global offline while the browser reports online', () => {
        expect(
            practiceFeedOnlineAfterRead({
                currentOnline: true,
                navigatorOnline: true,
                outcome: {
                    status: 'FAILURE',
                    error: new TypeError('Transient feed request failure'),
                },
            })
        ).toBe(true);

        expect(
            practiceFeedOnlineAfterRead({
                currentOnline: true,
                navigatorOnline: false,
                outcome: {
                    status: 'FAILURE',
                    error: new TypeError('Browser is offline'),
                },
            })
        ).toBe(false);
    });

    it('recovers global online state after a successful read when the browser is online', () => {
        expect(
            practiceFeedOnlineAfterRead({
                currentOnline: false,
                navigatorOnline: true,
                outcome: { status: 'SUCCESS' },
            })
        ).toBe(true);

        expect(
            practiceFeedOnlineAfterRead({
                currentOnline: false,
                navigatorOnline: false,
                outcome: { status: 'SUCCESS' },
            })
        ).toBe(false);
    });

    it.each([
        'ADVANCE_STARTED',
        'PAGE_SUCCEEDED',
        'PROMPT_ACTIVATED',
    ] as const)('clears a stale page error after %s', (event) => {
        expect(
            practiceFeedLoadErrorAfterEvent(
                'Try loading the next position again.',
                event
            )
        ).toBeNull();
    });
});

describe('practice owner fencing', () => {
    it('uses the SSR owner only until the live session resolves', () => {
        expect(
            resolvePracticeOwnerId({
                sessionStatus: 'loading',
                liveOwnerId: null,
                initialOwnerId: 'user-a',
            })
        ).toBe('user-a');
        expect(
            resolvePracticeOwnerId({
                sessionStatus: 'authenticated',
                liveOwnerId: 'user-b',
                initialOwnerId: 'user-a',
            })
        ).toBe('user-b');
        expect(
            resolvePracticeOwnerId({
                sessionStatus: 'unauthenticated',
                liveOwnerId: null,
                initialOwnerId: 'user-a',
            })
        ).toBeNull();
    });

    it('drops a deferred user A result after switching to B without writing A outbox state', async () => {
        let resolveRead!: (value: TrainingPromptDto) => void;
        const deferredRead = new Promise<TrainingPromptDto>((resolve) => {
            resolveRead = resolve;
        });
        let currentOwnerId: string | null = 'user-a';
        let currentGeneration = 1;
        const run = { ownerId: 'user-a', generation: 1 };
        let committedPrompt: TrainingPromptDto | null = null;
        const storage = new Map<string, string>();

        const completion = deferredRead.then((result) => {
            if (
                !isPracticeOwnerRunCurrent({
                    expectedOwnerId: run.ownerId,
                    currentOwnerId,
                    generation: run.generation,
                    currentGeneration,
                })
            ) {
                return;
            }
            committedPrompt = result;
            storage.set(trainingQueueStorageKey(run.ownerId), 'stale-write');
        });

        currentOwnerId = 'user-b';
        currentGeneration += 1;
        resolveRead(prompt('user-a-moment'));
        await completion;

        expect(committedPrompt).toBeNull();
        expect(storage.has(trainingQueueStorageKey('user-a'))).toBe(false);
        expect(storage.has(trainingQueueStorageKey('user-b'))).toBe(false);
    });
});
