export const PUZZLE_ATTEMPT_REVEALED_SENTINEL =
    '__backranq_outcome_revealed__';
export const PUZZLE_ATTEMPT_SKIPPED_SENTINEL =
    '__backranq_outcome_skipped__';
export const MAX_PUZZLE_ATTEMPT_TIME_MS = 24 * 60 * 60 * 1000;

export type PuzzleNonMoveOutcome = 'revealed' | 'skipped';

export function puzzleOutcomeToSentinel(outcome: PuzzleNonMoveOutcome) {
    return outcome === 'revealed'
        ? PUZZLE_ATTEMPT_REVEALED_SENTINEL
        : PUZZLE_ATTEMPT_SKIPPED_SENTINEL;
}

export function puzzleOutcomeFromMove(
    userMoveUci: string
): PuzzleNonMoveOutcome | null {
    if (userMoveUci === PUZZLE_ATTEMPT_REVEALED_SENTINEL) return 'revealed';
    if (userMoveUci === PUZZLE_ATTEMPT_SKIPPED_SENTINEL) return 'skipped';
    return null;
}

export function isValidUciMove(userMoveUci: string) {
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(userMoveUci);
}
