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
