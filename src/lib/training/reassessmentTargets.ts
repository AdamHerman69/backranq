function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bind fresh targeting metadata to the exact source and account being analyzed. */
export function readPracticeReassessmentTargets(payload: unknown, expected: {
    ownerId: string; gameId: string; pgn: string;
}): number[] {
    if (!record(payload) || payload.ownerId !== expected.ownerId || !record(payload.game)
        || payload.game.id !== expected.gameId || payload.game.pgn !== expected.pgn
        || !record(payload.reassessment) || typeof payload.reassessment.sourcePgnHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(payload.reassessment.sourcePgnHash)
        || !Array.isArray(payload.reassessment.decisionPlies)
        || !payload.reassessment.decisionPlies.every(ply => Number.isSafeInteger(ply) && ply >= 0)) {
        throw new Error('Game or account changed. Reload the game before analyzing it.');
    }
    return [...new Set(payload.reassessment.decisionPlies as number[])];
}
