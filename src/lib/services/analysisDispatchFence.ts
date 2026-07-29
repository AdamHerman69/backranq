export type AnalysisDispatchFence = {
    lockedAt: Date;
    dispatchedCount: number;
};

const DISPATCH_TOKEN_PREFIX = 'analysis-delivery-v1';

export function createAnalysisDispatchToken(args: {
    jobId: string;
    lockedAt: Date;
    dispatchedCount: number;
}) {
    return [
        DISPATCH_TOKEN_PREFIX,
        args.jobId,
        Math.max(0, Math.trunc(args.dispatchedCount)),
        args.lockedAt.getTime(),
    ].join(':');
}

export function parseAnalysisDispatchToken(args: {
    jobId: string;
    dispatchToken: string | null | undefined;
}): AnalysisDispatchFence | null {
    if (typeof args.dispatchToken !== 'string') return null;
    const [prefix, tokenJobId, dispatchedCountRaw, lockedAtRaw, ...rest] =
        args.dispatchToken.split(':');
    if (
        prefix !== DISPATCH_TOKEN_PREFIX ||
        tokenJobId !== args.jobId ||
        rest.length > 0
    ) {
        return null;
    }

    const dispatchedCount = Number(dispatchedCountRaw);
    const lockedAtMs = Number(lockedAtRaw);
    if (
        !Number.isSafeInteger(dispatchedCount) ||
        dispatchedCount <= 0 ||
        !Number.isSafeInteger(lockedAtMs) ||
        lockedAtMs <= 0
    ) {
        return null;
    }

    return {
        dispatchedCount,
        lockedAt: new Date(lockedAtMs),
    };
}
