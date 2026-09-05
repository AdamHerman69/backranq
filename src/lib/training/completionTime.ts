// Match the clock skew accepted by Coach completions and practice exposures.
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseTrainingCompletionTime(
    value: unknown,
    receivedAt?: Date
): Date | null {
    if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) {
        return null;
    }
    const completedAt = new Date(value);
    if (
        !Number.isFinite(completedAt.getTime()) ||
        completedAt.getUTCFullYear() < 1 ||
        completedAt.toISOString() !== value ||
        (receivedAt !== undefined &&
            (!Number.isFinite(receivedAt.getTime()) ||
                completedAt.getTime() >
                    receivedAt.getTime() + MAX_FUTURE_SKEW_MS))
    ) {
        return null;
    }
    return completedAt;
}
