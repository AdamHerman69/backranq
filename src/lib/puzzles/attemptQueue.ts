export const PUZZLE_ATTEMPT_QUEUE_STORAGE_PREFIX =
    'backranq.puzzleAttemptQueue.v2';

export function puzzleAttemptQueueStorageKey(userId: string) {
    return `${PUZZLE_ATTEMPT_QUEUE_STORAGE_PREFIX}.${userId}`;
}

export type PuzzleAttemptFlushRun = {
    userId: string;
    generation: number;
};

export function isCurrentPuzzleAttemptFlushRun(
    current: PuzzleAttemptFlushRun | null,
    candidate: PuzzleAttemptFlushRun
) {
    return (
        current?.userId === candidate.userId &&
        current.generation === candidate.generation
    );
}

export function tryWritePuzzleAttemptQueue(
    storage: Pick<Storage, 'setItem'>,
    key: string,
    serializedQueue: string
) {
    try {
        storage.setItem(key, serializedQueue);
        return true;
    } catch {
        return false;
    }
}

export async function directSaveAfterQueueWriteFailure(
    queueWriteSucceeded: boolean,
    sendDirect: () => Promise<void>
) {
    if (queueWriteSucceeded) {
        return { ok: true as const, direct: false as const };
    }
    try {
        await sendDirect();
        return { ok: true as const, direct: true as const };
    } catch (error) {
        return { ok: false as const, direct: true as const, error };
    }
}
