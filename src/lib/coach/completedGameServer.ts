import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';

import {
    COACH_OPPONENT_NAME,
    COACH_PLAYER_NAME,
    MAX_COACH_GAME_PGN_BYTES,
    MAX_COACH_SESSION_ID_LENGTH,
} from '@/lib/coach/completedGameContract';
import type { NormalizedGame } from '@/lib/types/game';

export type CompletedCoachGameErrorCode =
    | 'INVALID_SESSION'
    | 'INVALID_PGN'
    | 'INCOMPLETE_GAME'
    | 'INVALID_COMPLETION_TIME';

export class CompletedCoachGameError extends Error {
    constructor(
        readonly code: CompletedCoachGameErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'CompletedCoachGameError';
    }
}

function resultFor(game: Chess) {
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

export function normalizedCompletedCoachGame(args: {
    sessionId: string;
    pgn: string;
    userSide: 'white' | 'black';
    completedAt: string;
}): NormalizedGame {
    if (
        !args.sessionId ||
        args.sessionId.length > MAX_COACH_SESSION_ID_LENGTH ||
        !/^[A-Za-z0-9:_-]+$/.test(args.sessionId)
    ) {
        throw new CompletedCoachGameError(
            'INVALID_SESSION',
            'Coach session identity is invalid.'
        );
    }
    if (new TextEncoder().encode(args.pgn).byteLength > MAX_COACH_GAME_PGN_BYTES) {
        throw new CompletedCoachGameError('INVALID_PGN', 'Coach PGN is too large.');
    }
    const completedAt = new Date(args.completedAt);
    if (
        Number.isNaN(completedAt.getTime()) ||
        completedAt.getTime() > Date.now() + 5 * 60_000
    ) {
        throw new CompletedCoachGameError(
            'INVALID_COMPLETION_TIME',
            'Coach completion time is invalid.'
        );
    }
    const game = new Chess();
    try {
        game.loadPgn(args.pgn, { strict: false });
    } catch {
        throw new CompletedCoachGameError('INVALID_PGN', 'Coach PGN is invalid.');
    }
    if (game.history().length === 0 || !game.isGameOver()) {
        throw new CompletedCoachGameError(
            'INCOMPLETE_GAME',
            'Only completed Coach games can be saved.'
        );
    }

    const userIsWhite = args.userSide === 'white';
    const iso = completedAt.toISOString();
    game.setHeader('Event', 'Backranq Coach');
    game.setHeader('Site', 'Backranq');
    game.setHeader('UTCDate', iso.slice(0, 10).replaceAll('-', '.'));
    game.setHeader('UTCTime', iso.slice(11, 19));
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
    const canonicalPgn = game.pgn({ newline: '\n', maxWidth: 0 });
    const externalId = createHash('sha256')
        .update(`backranq-coach-session\u0000${args.sessionId}`)
        .digest('hex');

    return {
        id: `backranq_coach:${externalId}`,
        provider: 'backranq_coach',
        playedAt: iso,
        timeClass: 'unknown',
        rated: false,
        white: { name: userIsWhite ? COACH_PLAYER_NAME : COACH_OPPONENT_NAME },
        black: { name: userIsWhite ? COACH_OPPONENT_NAME : COACH_PLAYER_NAME },
        result: resultFor(game),
        termination: terminationFor(game),
        pgn: canonicalPgn,
        provenance: {
            username: COACH_PLAYER_NAME,
            userSide: args.userSide,
        },
    };
}
