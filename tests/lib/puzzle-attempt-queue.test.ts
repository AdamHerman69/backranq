import { describe, expect, it } from 'vitest';

import {
    isCurrentPuzzleAttemptFlushRun,
    directSaveAfterQueueWriteFailure,
    puzzleAttemptQueueStorageKey,
    tryWritePuzzleAttemptQueue,
    type PuzzleAttemptFlushRun,
} from '@/lib/puzzles/attemptQueue';

describe('puzzle attempt queue isolation', () => {
    it('uses a distinct storage namespace for every authenticated user', () => {
        const first = puzzleAttemptQueueStorageKey('user-a');
        const second = puzzleAttemptQueueStorageKey('user-b');

        expect(first).not.toBe(second);
        expect(first).toContain('user-a');
        expect(second).toContain('user-b');
        expect(first).not.toContain('v1');
    });

    it('does not let an old same-user run release a newer run', () => {
        const oldRun: PuzzleAttemptFlushRun = {
            userId: 'user-a',
            generation: 1,
        };
        const newRun: PuzzleAttemptFlushRun = {
            userId: 'user-a',
            generation: 2,
        };
        let current: PuzzleAttemptFlushRun | null = oldRun;

        current = newRun;
        if (isCurrentPuzzleAttemptFlushRun(current, oldRun)) current = null;

        expect(current).toEqual(newRun);
        expect(isCurrentPuzzleAttemptFlushRun(current, newRun)).toBe(true);
    });

    it('reports storage quota failures instead of claiming success', () => {
        const storage = {
            setItem() {
                throw new DOMException('Quota exceeded', 'QuotaExceededError');
            },
        };

        expect(
            tryWritePuzzleAttemptQueue(storage, 'queue-key', '[]')
        ).toBe(false);
    });

    it('falls back to a direct save with the same activity when queue storage fails', async () => {
        let directCalls = 0;
        const result = await directSaveAfterQueueWriteFailure(false, async () => {
            directCalls += 1;
        });

        expect(result).toEqual({ ok: true, direct: true });
        expect(directCalls).toBe(1);
    });

    it('reports unsaved activity when both queue storage and direct save fail', async () => {
        const result = await directSaveAfterQueueWriteFailure(false, async () => {
            throw new Error('offline');
        });

        expect(result.ok).toBe(false);
        expect(result.direct).toBe(true);
    });
});
