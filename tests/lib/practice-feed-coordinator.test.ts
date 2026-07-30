import { describe, expect, it, vi } from 'vitest';

import {
    abortCoordinatedPracticeFeedRequest,
    startCoordinatedPracticeFeedRequest,
    type PracticeFeedRequestSlot,
} from '@/lib/training/practiceFeedCoordinator';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('practice feed request coordinator', () => {
    it('shares one in-flight page request across concurrent low-water triggers', async () => {
        const response = deferred<string>();
        const request = vi.fn(() => response.promise);
        const onSuccess = vi.fn((value: string) => [value]);
        const slot: PracticeFeedRequestSlot<string[]> = {
            current: null,
        };
        const options = {
            slot,
            generation: 1,
            isGenerationCurrent: (generation: number) =>
                generation === 1,
            request,
            onSuccess,
            onFailure: vi.fn(),
            staleResult: () => [] as string[],
        };

        const first = startCoordinatedPracticeFeedRequest(options);
        const second = startCoordinatedPracticeFeedRequest(options);

        expect(second).toBe(first);
        expect(request).toHaveBeenCalledTimes(1);

        response.resolve('page-1');
        await expect(first).resolves.toEqual(['page-1']);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(slot.current).toBeNull();
    });

    it('prevents a reset generation from committing after its replacement starts', async () => {
        let currentGeneration = 1;
        const oldResponse = deferred<string>();
        const newResponse = deferred<string>();
        const committed: string[] = [];
        const slot: PracticeFeedRequestSlot<string[]> = {
            current: null,
        };

        const oldRequest = startCoordinatedPracticeFeedRequest({
            slot,
            generation: 1,
            isGenerationCurrent: (generation) =>
                generation === currentGeneration,
            request: () => oldResponse.promise,
            onSuccess: (value) => {
                committed.push(value);
                return [value];
            },
            onFailure: vi.fn(),
            staleResult: () => [],
        });

        currentGeneration = 2;
        abortCoordinatedPracticeFeedRequest(slot);
        const replacementRequest =
            startCoordinatedPracticeFeedRequest({
                slot,
                generation: 2,
                isGenerationCurrent: (generation) =>
                    generation === currentGeneration,
                request: () => newResponse.promise,
                onSuccess: (value) => {
                    committed.push(value);
                    return [value];
                },
                onFailure: vi.fn(),
                staleResult: () => [],
            });

        oldResponse.resolve('stale-page');
        await expect(oldRequest).resolves.toEqual([]);
        expect(committed).toEqual([]);
        expect(slot.current?.generation).toBe(2);

        newResponse.resolve('replacement-page');
        await expect(replacementRequest).resolves.toEqual([
            'replacement-page',
        ]);
        expect(committed).toEqual(['replacement-page']);
        expect(slot.current).toBeNull();
    });
});
