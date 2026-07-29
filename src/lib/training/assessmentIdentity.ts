import { Chess } from 'chess.js';

export const MAX_ASSESSMENT_POSITION_HISTORY = 256;

export function repetitionPositionKey(fen: string): string | null {
    try {
        return new Chess(fen)
            .fen()
            .split(/\s+/)
            .slice(0, 4)
            .join(' ');
    } catch {
        return null;
    }
}

function halfmoveAwarePositionKey(fen: string): string {
    return new Chess(fen)
        .fen()
        .split(/\s+/)
        .slice(0, 5)
        .join(' ');
}

/**
 * Small deterministic browser-safe fingerprint. This is an identity
 * namespace, not a security primitive; two independent FNV-1a passes make
 * accidental collisions in bounded repetition histories negligible.
 */
export function repetitionHistoryFingerprint(
    positionHistory: readonly string[]
): string {
    const canonical = positionHistory
        .slice(-MAX_ASSESSMENT_POSITION_HISTORY)
        .map(repetitionPositionKey)
        .filter((key): key is string => key !== null)
        .join('\u0000');
    const hash = (seed: number) => {
        let value = seed >>> 0;
        for (let index = 0; index < canonical.length; index += 1) {
            value ^= canonical.charCodeAt(index);
            value = Math.imul(value, 0x01000193) >>> 0;
        }
        return value.toString(16).padStart(8, '0');
    };
    return `${hash(0x811c9dc5)}${hash(0x9e3779b9)}`;
}

export function assessmentPositionKey(
    fen: string,
    positionHistory: readonly string[]
): string {
    return `${halfmoveAwarePositionKey(fen)}|history:${repetitionHistoryFingerprint(positionHistory)}`;
}

export function appendAssessmentHistory(
    positionHistory: readonly string[],
    fen: string
): string[] {
    return [...positionHistory, fen].slice(
        -MAX_ASSESSMENT_POSITION_HISTORY
    );
}
