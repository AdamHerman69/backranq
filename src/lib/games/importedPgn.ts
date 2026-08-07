import { Chess } from 'chess.js';

export const MAX_PGN_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_PGN_IMPORT_GAMES = 50;

export type ImportedGameSide = 'white' | 'black';
export type PgnImportErrorCode =
    | 'EMPTY'
    | 'TOO_LARGE'
    | 'TOO_MANY_GAMES'
    | 'INVALID_PGN'
    | 'NO_MOVES'
    | 'MISSING_PLAYERS'
    | 'AMBIGUOUS_PLAYER';

export class PgnImportError extends Error {
    constructor(
        readonly code: PgnImportErrorCode,
        message: string,
        readonly gameIndex?: number
    ) {
        super(message);
        this.name = 'PgnImportError';
    }
}

export type ParsedImportedPgn = {
    pgn: string;
    /** Canonical chess.js serialization used only for duplicate identity. */
    identityPgn: string;
    whiteName: string;
    blackName: string;
    whiteRating?: number;
    blackRating?: number;
    playedAt: string;
    result?: string;
    termination?: string;
    timeControl: {
        raw?: string;
        initialSeconds?: number;
        incrementSeconds?: number;
    };
    rated?: boolean;
};

function splitAtEventHeaders(input: string): string[] {
    const normalized = input.replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];

    const starts = Array.from(
        normalized.matchAll(/^\s*\[Event\s+"/gim),
        (match) => match.index
    );
    if (starts.length <= 1) return [normalized];
    if (normalized.slice(0, starts[0]).trim()) {
        throw new PgnImportError(
            'INVALID_PGN',
            'Text before the first PGN game is not supported.'
        );
    }
    return starts.map((start, index) =>
        normalized.slice(start, starts[index + 1] ?? normalized.length).trim()
    );
}

function optionalInt(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value.trim())) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseTimeControl(value: string | undefined) {
    if (!value) return {};
    const raw = value.trim();
    const match = /^(\d+)(?:\+(\d+))?$/.exec(raw);
    if (!match) return { raw };
    return {
        raw,
        initialSeconds: Number(match[1]),
        incrementSeconds: Number(match[2] ?? 0),
    };
}

function parsePlayedAt(headers: Record<string, string>, importedAt: Date) {
    const date = headers.UTCDate ?? headers.Date;
    const time = headers.UTCTime ?? '00:00:00';
    if (
        date &&
        /^\d{4}\.\d{2}\.\d{2}$/.test(date) &&
        /^\d{2}:\d{2}:\d{2}$/.test(time)
    ) {
        const isoDate = date.replaceAll('.', '-');
        const instant = new Date(`${isoDate}T${time}Z`);
        if (
            !Number.isNaN(instant.getTime()) &&
            instant.toISOString().slice(0, 10) === isoDate &&
            instant.toISOString().slice(11, 19) === time
        ) {
            return instant.toISOString();
        }
    }
    return importedAt.toISOString();
}

function parseRated(headers: Record<string, string>): boolean | undefined {
    const event = headers.Event?.toLowerCase() ?? '';
    if (event.includes('rated')) return true;
    if (event.includes('casual') || event.includes('unrated')) return false;
    return undefined;
}

export function parseImportedPgnCollection(
    input: string,
    options: { importedAt: Date }
): ParsedImportedPgn[] {
    if (new TextEncoder().encode(input).byteLength > MAX_PGN_IMPORT_BYTES) {
        throw new PgnImportError('TOO_LARGE', 'PGN import is larger than 2 MB.');
    }
    if (Number.isNaN(options.importedAt.getTime())) {
        throw new PgnImportError('INVALID_PGN', 'Import time is invalid.');
    }

    const chunks = splitAtEventHeaders(input);
    if (chunks.length === 0) {
        throw new PgnImportError('EMPTY', 'Paste at least one PGN game.');
    }
    if (chunks.length > MAX_PGN_IMPORT_GAMES) {
        throw new PgnImportError(
            'TOO_MANY_GAMES',
            `Import at most ${MAX_PGN_IMPORT_GAMES} games at a time.`
        );
    }

    return chunks.map((pgn, index) => {
        const gameIndex = index + 1;
        const chess = new Chess();
        try {
            chess.loadPgn(pgn, { strict: false });
        } catch {
            throw new PgnImportError(
                'INVALID_PGN',
                `Game ${gameIndex} is not valid PGN.`,
                gameIndex
            );
        }
        if (chess.history().length === 0) {
            throw new PgnImportError(
                'NO_MOVES',
                `Game ${gameIndex} does not contain any moves.`,
                gameIndex
            );
        }

        const headers = chess.getHeaders();
        const whiteName = headers.White?.trim();
        const blackName = headers.Black?.trim();
        if (!whiteName || !blackName) {
            throw new PgnImportError(
                'MISSING_PLAYERS',
                `Game ${gameIndex} must include White and Black headers.`,
                gameIndex
            );
        }

        const result = headers.Result?.trim();
        return {
            pgn,
            identityPgn: chess.pgn({ newline: '\n', maxWidth: 0 }),
            whiteName,
            blackName,
            whiteRating: optionalInt(headers.WhiteElo),
            blackRating: optionalInt(headers.BlackElo),
            playedAt: parsePlayedAt(headers, options.importedAt),
            result: result && result !== '*' ? result : undefined,
            termination: headers.Termination?.trim() || undefined,
            timeControl: parseTimeControl(headers.TimeControl),
            rated: parseRated(headers),
        };
    });
}

export function resolveImportedGameSide(args: {
    game: Pick<ParsedImportedPgn, 'whiteName' | 'blackName'>;
    playerName?: string;
    explicitSide?: ImportedGameSide;
}): ImportedGameSide {
    if (args.explicitSide) return args.explicitSide;
    const enteredName = args.playerName?.trim();
    const playerName = enteredName?.toLowerCase();
    if (!playerName) {
        throw new PgnImportError(
            'AMBIGUOUS_PLAYER',
            'Enter your player name so Backranq knows which moves to train.'
        );
    }
    const whiteMatches = args.game.whiteName.trim().toLowerCase() === playerName;
    const blackMatches = args.game.blackName.trim().toLowerCase() === playerName;
    if (whiteMatches === blackMatches) {
        throw new PgnImportError(
            'AMBIGUOUS_PLAYER',
            `Player "${enteredName}" does not identify exactly one side in ${args.game.whiteName} vs ${args.game.blackName}.`
        );
    }
    return whiteMatches ? 'white' : 'black';
}
