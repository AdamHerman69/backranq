import { Chess, type Move, type Square } from 'chess.js';

import type { Puzzle } from '@/lib/analysis/puzzles';
import type { Score } from '@/lib/analysis/stockfishClient';
import type { PuzzleAttemptStats } from '@/lib/api/puzzles';
import {
    extractStartFenFromPgn,
    parseUci,
} from '@/lib/chess/utils';
import type { NormalizedGame } from '@/lib/types/game';
import { puzzleOutcomeFromMove, type PuzzleNonMoveOutcome } from '@/lib/puzzles/attemptOutcomes';
import type { PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';

export type VerboseMove = Move & { promotion?: string };

export type SourceParsed = { startFen: string; moves: VerboseMove[] };
export type TrainerFilters = {
    type: '' | 'avoidBlunder' | 'punishBlunder';
    kind: '' | 'blunder' | 'missedWin' | 'missedTactic';
    phase: '' | 'opening' | 'middlegame' | 'endgame';
    multiSolution: '' | 'single' | 'multi';
    openingEco: string[];
    tags: string[];
    solved: boolean | undefined;
    failed: boolean | undefined;
    gameId: string;
};

type DbGameLoose = Record<string, unknown>;

export type PuzzleAttemptRow = {
    id: string;
    attemptedAt: string;
    userMoveUci: string;
    wasCorrect: boolean;
    timeSpentMs: number | null;
    outcome: PuzzleNonMoveOutcome | null;
};

export function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function parsePuzzleAttemptStats(value: unknown): PuzzleAttemptStats | null {
    const stats = toRecord(value);
    const {
        attempted,
        correct,
        successRate,
        solved,
        failed,
        lastAttemptedAt,
        averageTimeMs,
        outcome,
    } = stats;

    if (
        typeof attempted !== 'number' ||
        typeof correct !== 'number' ||
        !(typeof successRate === 'number' || successRate === null) ||
        typeof solved !== 'boolean' ||
        typeof failed !== 'boolean' ||
        !(typeof lastAttemptedAt === 'string' || lastAttemptedAt === null) ||
        !(typeof averageTimeMs === 'number' || averageTimeMs === null) ||
        !(
            outcome === 'new' ||
            outcome === 'solved' ||
            outcome === 'failed' ||
            outcome === 'revealed' ||
            outcome === 'skipped'
        )
    ) {
        return null;
    }

    return {
        attempted,
        correct,
        successRate,
        solved,
        failed,
        lastAttemptedAt,
        averageTimeMs,
        outcome,
    };
}

function parsePuzzleAttemptRow(value: unknown): PuzzleAttemptRow | null {
    const row = toRecord(value);
    const { id, attemptedAt, userMoveUci, wasCorrect, timeSpentMs } = row;
    const outcome =
        row.outcome === 'revealed' || row.outcome === 'skipped'
            ? row.outcome
            : puzzleOutcomeFromMove(
                  typeof userMoveUci === 'string' ? userMoveUci : ''
              );

    if (
        typeof id !== 'string' ||
        typeof attemptedAt !== 'string' ||
        typeof userMoveUci !== 'string' ||
        typeof wasCorrect !== 'boolean' ||
        !(typeof timeSpentMs === 'number' || timeSpentMs == null)
    ) {
        return null;
    }

    return {
        id,
        attemptedAt,
        userMoveUci,
        wasCorrect,
        timeSpentMs: timeSpentMs ?? null,
        outcome,
    };
}

export function parsePuzzleAttempts(value: unknown): PuzzleAttemptRow[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((attempt) => parsePuzzleAttemptRow(attempt))
        .filter((attempt): attempt is PuzzleAttemptRow => attempt !== null);
}

export function describeFilters(f: PuzzlesFilters): string {
    const parts: string[] = [];

    const labelType: Record<PuzzlesFilters['type'], string> = {
        '': '',
        avoidBlunder: 'Avoid blunder',
        punishBlunder: 'Punish blunder',
    };
    const labelKind: Record<PuzzlesFilters['kind'], string> = {
        '': '',
        blunder: 'Blunder',
        missedWin: 'Missed win',
        missedTactic: 'Missed tactic',
    };
    const labelPhase: Record<PuzzlesFilters['phase'], string> = {
        '': '',
        opening: 'Opening',
        middlegame: 'Middlegame',
        endgame: 'Endgame',
    };
    const labelMulti: Record<PuzzlesFilters['multiSolution'], string> = {
        '': '',
        any: 'Any',
        single: 'Single-solution',
        multi: 'Multi-solution',
    };
    const labelStatus: Record<PuzzlesFilters['status'], string> = {
        '': '',
        solved: 'Solved',
        failed: 'Failed',
        attempted: 'Attempted',
    };

    if (f.type) parts.push(`Type: ${labelType[f.type]}`);
    if (f.kind) parts.push(`Kind: ${labelKind[f.kind]}`);
    if (f.phase) parts.push(`Phase: ${labelPhase[f.phase]}`);
    if (f.multiSolution && f.multiSolution !== 'any')
        parts.push(`Solutions: ${labelMulti[f.multiSolution]}`);
    if (f.status) parts.push(`Status: ${labelStatus[f.status]}`);

    if (f.openingEco?.length) {
        const codes = f.openingEco.map((s) => s.toUpperCase());
        const first = codes.slice(0, 2).join(', ');
        parts.push(
            `Openings: ${first}${codes.length > 2 ? ` +${codes.length - 2}` : ''}`
        );
    }
    if (f.tags?.length) {
        const first = f.tags.slice(0, 2).join(', ');
        parts.push(`Tags: ${first}${f.tags.length > 2 ? ` +${f.tags.length - 2}` : ''}`);
    }
    if (f.gameId) parts.push(`Game: ${f.gameId}`);

    return parts.length ? parts.join(' · ') : 'all';
}

function timeClassToUi(tc: string): NormalizedGame['timeClass'] {
    const t = (tc ?? '').toUpperCase();
    if (t === 'BULLET') return 'bullet';
    if (t === 'BLITZ') return 'blitz';
    if (t === 'RAPID') return 'rapid';
    if (t === 'CLASSICAL') return 'classical';
    return 'unknown';
}

function providerToUi(p: string): NormalizedGame['provider'] {
    return (p ?? '').toUpperCase() === 'CHESSCOM' ? 'chesscom' : 'lichess';
}

export function dbGameToNormalizedLoose(game: DbGameLoose): NormalizedGame {
    return {
        id: String(game['id']),
        provider: providerToUi(String(game['provider'] ?? '')),
        url: typeof game['url'] === 'string' ? game['url'] : undefined,
        playedAt:
            typeof game['playedAt'] === 'string'
                ? String(game['playedAt'])
                : new Date(String(game['playedAt'] ?? Date.now())).toISOString(),
        timeClass: timeClassToUi(String(game['timeClass'] ?? '')),
        rated: typeof game['rated'] === 'boolean' ? game['rated'] : undefined,
        white: {
            name: String(game['whiteName'] ?? ''),
            rating:
                typeof game['whiteRating'] === 'number'
                    ? game['whiteRating']
                    : undefined,
        },
        black: {
            name: String(game['blackName'] ?? ''),
            rating:
                typeof game['blackRating'] === 'number'
                    ? game['blackRating']
                    : undefined,
        },
        result: typeof game['result'] === 'string' ? game['result'] : undefined,
        termination:
            typeof game['termination'] === 'string' ? game['termination'] : undefined,
        pgn: String(game['pgn'] ?? ''),
    };
}

export function parseSourceGame(pgn: string): SourceParsed | null {
    if (!pgn) return null;
    const chess = new Chess();
    try {
        chess.loadPgn(pgn, { strict: false });
    } catch {
        return null;
    }
    const moves = chess.history({ verbose: true }) as VerboseMove[];
    const fenTag = extractStartFenFromPgn(pgn);
    if (fenTag) return { startFen: fenTag, moves };

    const startChess = new Chess();
    try {
        startChess.loadPgn(pgn, { strict: false });
        while (startChess.undo()) {}
        return { startFen: startChess.fen(), moves };
    } catch {
        return { startFen: new Chess().fen(), moves };
    }
}

export function formatEval(score: Score | null, fen: string): string {
    if (!score) return '—';
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1;
    if (score.type === 'cp') {
        const v = (score.value / 100) * sign;
        return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
    }
    return `#${score.value * sign}`;
}

export function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

export function scoreToUnit(score: Score | null, fen: string): number {
    if (!score) return 0.5;
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1;

    if (score.type === 'mate') {
        return score.value * sign > 0 ? 1 : 0;
    }
    const x = (score.value * sign) / 600;
    return 0.5 + 0.5 * Math.tanh(x);
}

export function isEditableTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    return Boolean(
        el.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="option"], [role="dialog"]'
        )
    );
}

export function findPuzzleLastMove(args: {
    puzzle: Puzzle;
    source: SourceParsed;
}): { from: Square; to: Square } | null {
    const { puzzle, source } = args;
    const c = new Chess(source.startFen);
    const max = Math.min(source.moves.length, Math.max(0, puzzle.sourcePly));
    let last: { from: Square; to: Square } | null = null;

    for (let i = 0; i < max; i++) {
        const m = source.moves[i];
        try {
            const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion });
            if (!mv) break;
            last = { from: mv.from as Square, to: mv.to as Square };
        } catch {
            break;
        }
    }

    return last;
}

export function uciToArrow(uci: string): { from: Square; to: Square } | null {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    return { from: parsed.from as Square, to: parsed.to as Square };
}

export function parseCsv(v: string | null, max: number): string[] {
    const s = (v ?? '').trim();
    if (!s) return [];
    return s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, max);
}
