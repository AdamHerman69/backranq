export function shouldPollAnalysis(input: {
    authenticated: boolean;
    ownerId: string | null;
    hasTrackedServerBatch: boolean;
    serverQueued: number;
    serverRunning: number;
    browserRunning: boolean;
}) {
    return (
        input.authenticated &&
        !!input.ownerId &&
        (input.hasTrackedServerBatch ||
            input.serverQueued + input.serverRunning > 0 ||
            input.browserRunning)
    );
}

export const IDLE_ANALYSIS_STATUS_DELAY_MS = 15_000;

export function initialAnalysisStatusDelayMs(input: {
    authenticated: boolean;
    ownerId: string | null;
    hasTrackedServerBatch: boolean;
}): number | null {
    if (!input.authenticated || !input.ownerId) return null;
    return input.hasTrackedServerBatch
        ? 0
        : IDLE_ANALYSIS_STATUS_DELAY_MS;
}
