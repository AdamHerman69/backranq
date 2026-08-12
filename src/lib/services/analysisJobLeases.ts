// The worker yields by 180s and the platform hard-stops at 300s. This leaves
// 90s for persistence/settlement while recovering hard kills within one sweep.
export const DEFAULT_ANALYSIS_JOB_LEASE_MS = 270_000;
export const DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS = 5;
export const DEFAULT_ANALYSIS_RETRY_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_ANALYSIS_RETRY_BACKOFF_MAX_MS = 30 * 60_000;

export type AnalysisJobLeaseOptions = {
    now?: Date;
    leaseMs?: number;
};

export function getAnalysisJobLockedUntil({
    now = new Date(),
    leaseMs = DEFAULT_ANALYSIS_JOB_LEASE_MS,
}: AnalysisJobLeaseOptions = {}) {
    return new Date(now.getTime() + Math.max(0, leaseMs));
}

export function analysisJobRunningLeaseData(
    options: AnalysisJobLeaseOptions = {}
) {
    const now = options.now ?? new Date();
    return {
        attempts: { increment: 1 },
        lockedAt: now,
        lockedUntil: getAnalysisJobLockedUntil({
            now,
            leaseMs: options.leaseMs,
        }),
        startedAt: now,
    };
}

export function analysisJobClearedLeaseData() {
    return {
        lockedAt: null,
        lockedUntil: null,
    };
}

export function getAnalysisRetryScheduledFor(args: {
    attempts: number;
    now?: Date;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
}) {
    const now = args.now ?? new Date();
    const baseMs = args.retryBackoffBaseMs ?? DEFAULT_ANALYSIS_RETRY_BACKOFF_BASE_MS;
    const maxMs = args.retryBackoffMaxMs ?? DEFAULT_ANALYSIS_RETRY_BACKOFF_MAX_MS;
    const backoffMs = Math.min(
        maxMs,
        baseMs * 2 ** Math.max(0, args.attempts - 1)
    );
    return new Date(now.getTime() + Math.max(0, backoffMs));
}
