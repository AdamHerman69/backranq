export type BrowserGameAnalysisEngine = {
    cancelAll(): void;
    terminate(): void;
};

export type BrowserGameAnalysisRun<
    Engine extends BrowserGameAnalysisEngine = BrowserGameAnalysisEngine,
> = {
    ownerId: string;
    generation: number;
    controller: AbortController;
    engine: Engine;
    cleaned: boolean;
};

export function isBrowserGameAnalysisRunCurrent<
    Engine extends BrowserGameAnalysisEngine,
>({
    run,
    activeRun,
    activeOwnerId,
    currentGeneration,
}: {
    run: BrowserGameAnalysisRun<Engine>;
    activeRun: BrowserGameAnalysisRun<Engine> | null;
    activeOwnerId: string | null;
    currentGeneration: number;
}): boolean {
    return (
        !run.controller.signal.aborted &&
        activeRun === run &&
        activeOwnerId === run.ownerId &&
        currentGeneration === run.generation
    );
}

export function cleanupBrowserGameAnalysisRun<
    Engine extends BrowserGameAnalysisEngine,
>(run: BrowserGameAnalysisRun<Engine> | null): void {
    if (!run || run.cleaned) return;
    run.cleaned = true;
    run.controller.abort();
    try {
        run.engine.cancelAll();
    } catch {
        // Termination remains mandatory even if an engine rejects cancellation.
    }
    try {
        run.engine.terminate();
    } catch {
        // Cleanup must never crash an unmount or account transition.
    }
}
