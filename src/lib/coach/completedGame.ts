import { Chess } from 'chess.js';

import { publishLibraryChanged } from '@/lib/analysis/analysisCompletion';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import {
    COACH_OPPONENT_NAME,
    COACH_PLAYER_NAME,
    MAX_COACH_GAME_PGN_BYTES,
    MAX_COACH_SESSION_ID_LENGTH,
    type CompletedCoachGamePayload,
    type SavedCoachGame,
} from '@/lib/coach/completedGameContract';

function resultFor(game: Chess) {
    if (!game.isGameOver()) {
        throw new Error('Only completed Coach games can be saved.');
    }
    if (!game.isCheckmate()) return '1/2-1/2';
    return game.turn() === 'w' ? '0-1' : '1-0';
}

function terminationFor(game: Chess) {
    if (game.isCheckmate()) return 'Checkmate';
    if (game.isStalemate()) return 'Stalemate';
    if (game.isThreefoldRepetition()) return 'Threefold repetition';
    if (game.isInsufficientMaterial()) return 'Insufficient material';
    return 'Draw';
}

function utcHeaderParts(value: string) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
        throw new Error('Coach completion time is invalid.');
    }
    const iso = instant.toISOString();
    return {
        date: iso.slice(0, 10).replaceAll('-', '.'),
        time: iso.slice(11, 19),
        completedAt: iso,
    };
}

export function buildCompletedCoachGamePayload(args: {
    game: Chess;
    sessionId: string;
    userSide: 'w' | 'b';
    completedAt: string;
}): CompletedCoachGamePayload {
    const sessionId = args.sessionId.trim();
    if (
        !sessionId ||
        sessionId.length > MAX_COACH_SESSION_ID_LENGTH ||
        !/^[A-Za-z0-9:_-]+$/.test(sessionId)
    ) {
        throw new Error('Coach session identity is invalid.');
    }
    if (args.game.history().length === 0) {
        throw new Error('The Coach game does not contain any moves.');
    }
    const completed = utcHeaderParts(args.completedAt);
    const userIsWhite = args.userSide === 'w';
    const game = new Chess();
    game.loadPgn(args.game.pgn({ newline: '\n', maxWidth: 0 }), {
        strict: false,
    });
    game.setHeader('Event', 'Backranq Coach');
    game.setHeader('Site', 'Backranq');
    game.setHeader('UTCDate', completed.date);
    game.setHeader('UTCTime', completed.time);
    game.setHeader(
        'White',
        userIsWhite ? COACH_PLAYER_NAME : COACH_OPPONENT_NAME
    );
    game.setHeader(
        'Black',
        userIsWhite ? COACH_OPPONENT_NAME : COACH_PLAYER_NAME
    );
    game.setHeader('Result', resultFor(game));
    game.setHeader('Termination', terminationFor(game));
    const pgn = game.pgn({ newline: '\n', maxWidth: 0 });
    if (new TextEncoder().encode(pgn).byteLength > MAX_COACH_GAME_PGN_BYTES) {
        throw new Error('The completed Coach game is too large to save.');
    }
    return {
        sessionId,
        pgn,
        userSide: userIsWhite ? 'white' : 'black',
        completedAt: completed.completedAt,
    };
}

function isSavedCoachGame(value: unknown): value is SavedCoachGame {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.ownerId === 'string' &&
        typeof record.gameId === 'string' &&
        typeof record.created === 'boolean' &&
        typeof record.needsAnalysis === 'boolean'
    );
}

export async function saveCompletedCoachGameAndAnalyze(args: {
    ownerId: string;
    game: Chess;
    sessionId: string;
    userSide: 'w' | 'b';
    completedAt: string;
}): Promise<SavedCoachGame> {
    const payload = buildCompletedCoachGamePayload(args);
    const response = await fetch('/api/coach/games', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [EXPECTED_OWNER_HEADER]: args.ownerId,
        },
        body: JSON.stringify(payload),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isSavedCoachGame(result)) {
        const message =
            result &&
            typeof result === 'object' &&
            'error' in result &&
            typeof (result as { error?: unknown }).error === 'string'
                ? (result as { error: string }).error.trim().slice(0, 300)
                : '';
        throw new Error(
            message || 'The completed Coach game could not be saved.'
        );
    }
    if (result.ownerId !== args.ownerId) {
        throw new Error('The saved Coach game owner did not match this session.');
    }

    publishLibraryChanged(args.ownerId, { invalidateCompletion: true });
    if (result.needsAnalysis) {
        backgroundAnalysis.setOwner(args.ownerId);
        backgroundAnalysis.enqueueGameDbIds(args.ownerId, [result.gameId]);
    }
    return result;
}
