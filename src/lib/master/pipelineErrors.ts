export class WeeklyMasterTerminalError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'WeeklyMasterTerminalError';
    }
}

export function isWeeklyMasterTerminalError(
    error: unknown
): error is WeeklyMasterTerminalError {
    return error instanceof WeeklyMasterTerminalError;
}
