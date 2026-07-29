import { Chess } from 'chess.js';

import type {
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';

function normalizedUci(moveUci: string): string {
    return moveUci.trim().toLowerCase();
}

function coordinateMoveLabel(moveUci: string): string {
    const move = normalizedUci(moveUci);
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return moveUci;
    const promotion =
        move.length > 4 ? `=${move[4]!.toUpperCase()}` : '';
    return `${move.slice(0, 2)}–${move.slice(2, 4)}${promotion}`;
}

export function moveLabel(fen: string, moveUci: string | null): string {
    if (!moveUci) return '—';
    const move = normalizedUci(moveUci);
    try {
        const chess = new Chess(fen);
        const played = chess.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.slice(4, 5) || undefined,
        });
        return played?.san ?? coordinateMoveLabel(move);
    } catch {
        return coordinateMoveLabel(move);
    }
}

export function moveLineLabels(
    fen: string,
    movesUci: readonly string[]
): string[] {
    try {
        const chess = new Chess(fen);
        return movesUci.map((moveUci) => {
            const move = normalizedUci(moveUci);
            const played = chess.move({
                from: move.slice(0, 2),
                to: move.slice(2, 4),
                promotion: move.slice(4, 5) || undefined,
            });
            return played?.san ?? coordinateMoveLabel(move);
        });
    } catch {
        return movesUci.map(coordinateMoveLabel);
    }
}

function tablebaseWdlForSide(
    wdl: 'WIN' | 'DRAW' | 'LOSS',
    trainingSide: 'w' | 'b'
): 'WIN' | 'DRAW' | 'LOSS' {
    if (trainingSide === 'w' || wdl === 'DRAW') return wdl;
    return wdl === 'WIN' ? 'LOSS' : 'WIN';
}

export function formatScoreForTrainingSide(
    score: PovScore | null,
    trainingSide: 'w' | 'b'
): string {
    if (!score) return 'No stable evaluation';
    if (score.kind === 'cp') {
        const cp = trainingSide === 'w' ? score.cp : -score.cp;
        const pawns = Math.abs(cp / 100).toFixed(2);
        if (Math.abs(cp) < 1) return 'The position is equal';
        return cp > 0
            ? `You are better by ${pawns}`
            : `You are worse by ${pawns}`;
    }
    if (score.kind === 'mate') {
        const trainingSideWins =
            (score.winner === 'WHITE' && trainingSide === 'w') ||
            (score.winner === 'BLACK' && trainingSide === 'b');
        const moves = Math.max(1, Math.ceil(score.plies / 2));
        return trainingSideWins
            ? `You can force mate in ${moves}`
            : `Opponent can force mate in ${moves}`;
    }
    const wdl = tablebaseWdlForSide(score.wdl, trainingSide);
    const outcome =
        wdl === 'WIN'
            ? 'Tablebase win'
            : wdl === 'DRAW'
              ? 'Tablebase draw'
              : 'Tablebase loss';
    return outcome;
}

function formatPercentagePoints(value: number): string {
    const points = Math.max(0, value) * 100;
    const digits = points >= 10 ? 0 : 1;
    return `${points.toFixed(digits)} percentage points`;
}

export function formatOutcomeDifference(args: {
    winChance: number | null;
    cp: number | null;
    emptyLabel?: string;
}): string {
    if (
        typeof args.winChance === 'number' &&
        Number.isFinite(args.winChance)
    ) {
        return formatPercentagePoints(args.winChance);
    }
    if (typeof args.cp === 'number' && Number.isFinite(args.cp)) {
        return `${Math.round(Math.max(0, args.cp))} cp`;
    }
    return args.emptyLabel ?? 'Outcome preserved';
}

export function formatSignedOutcomeDifference(args: {
    winChance: number | null;
    cp: number | null;
}): string {
    if (
        typeof args.winChance === 'number' &&
        Number.isFinite(args.winChance)
    ) {
        const points = Math.abs(args.winChance) * 100;
        const digits = points >= 10 ? 0 : 1;
        const sign =
            args.winChance > 0 ? '+' : args.winChance < 0 ? '−' : '';
        return `${sign}${points.toFixed(digits)} percentage points`;
    }
    if (typeof args.cp === 'number' && Number.isFinite(args.cp)) {
        const sign = args.cp > 0 ? '+' : args.cp < 0 ? '−' : '';
        return `${sign}${Math.round(Math.abs(args.cp))} cp`;
    }
    return 'No measurable difference';
}

const SOURCE_LABELS: Record<TrainingSourceKind, string> = {
    MY_MISTAKE: 'Your game mistake',
    MISSED_OPPORTUNITY: 'Missed opportunity',
};

const LESSON_LABELS: Record<TrainingLessonKind, string> = {
    AVOID_MISTAKE: 'Avoid the mistake',
    PUNISH_MISTAKE: 'Punish the mistake',
    SAVE_DRAW: 'Save the draw',
    PRESERVE_WIN: 'Keep the win',
    CONVERT_ADVANTAGE: 'Convert the advantage',
    IMPROVE_POSITION: 'Improve the position',
};

export function sourceLabel(source: TrainingSourceKind): string {
    return SOURCE_LABELS[source];
}

export function lessonLabel(lesson: TrainingLessonKind): string {
    return LESSON_LABELS[lesson];
}

export function themeLabel(theme: string): string {
    return theme
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(
            (part) =>
                `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}`
        )
        .join(' ');
}
