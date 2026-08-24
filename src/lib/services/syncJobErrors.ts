export class SyncJobDeliveryDeferredError extends Error {
    readonly retryAfterSeconds: number;

    constructor(jobId: string, retryAfterSeconds: number) {
        super(`Sync job ${jobId} is already leased or is not due yet`);
        this.name = 'SyncJobDeliveryDeferredError';
        this.retryAfterSeconds = Math.max(
            1,
            Math.ceil(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1)
        );
    }
}
