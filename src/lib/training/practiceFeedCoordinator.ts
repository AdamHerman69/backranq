export type CoordinatedPracticeFeedRequest<TResult> = {
    controller: AbortController;
    generation: number;
    promise: Promise<TResult>;
};

export type PracticeFeedRequestSlot<TResult> = {
    current: CoordinatedPracticeFeedRequest<TResult> | null;
};

export function startCoordinatedPracticeFeedRequest<
    TResponse,
    TResult,
>({
    slot,
    generation,
    isGenerationCurrent,
    request,
    onSuccess,
    onFailure,
    staleResult,
}: {
    slot: PracticeFeedRequestSlot<TResult>;
    generation: number;
    isGenerationCurrent: (generation: number) => boolean;
    request: (signal: AbortSignal) => Promise<TResponse>;
    onSuccess: (response: TResponse) => TResult;
    onFailure: (error: unknown) => void;
    staleResult: () => TResult;
}): Promise<TResult> {
    if (slot.current) return slot.current.promise;

    const controller = new AbortController();
    let pendingResponse: Promise<TResponse>;
    try {
        pendingResponse = request(controller.signal);
    } catch (error) {
        pendingResponse = Promise.reject(error);
    }

    const promise = pendingResponse
        .then((response) => {
            if (
                controller.signal.aborted ||
                !isGenerationCurrent(generation)
            ) {
                return staleResult();
            }
            return onSuccess(response);
        })
        .catch((error) => {
            if (
                controller.signal.aborted ||
                !isGenerationCurrent(generation)
            ) {
                return staleResult();
            }
            onFailure(error);
            throw error;
        })
        .finally(() => {
            if (slot.current?.promise === promise) {
                slot.current = null;
            }
        });

    slot.current = { controller, generation, promise };
    return promise;
}

export function abortCoordinatedPracticeFeedRequest<TResult>(
    slot: PracticeFeedRequestSlot<TResult>,
    generation?: number
): void {
    const active = slot.current;
    if (
        !active ||
        (generation !== undefined &&
            active.generation !== generation)
    ) {
        return;
    }
    active.controller.abort();
    if (slot.current === active) slot.current = null;
}
