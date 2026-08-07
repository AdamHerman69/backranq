import type {
    NormalizedGame,
    GameSource as UiGameSource,
    SyncProvider as UiSyncProvider,
    TimeClass as UiTimeClass,
} from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type {
    AnalyzedGame,
    GameSource,
    SyncProvider,
    TimeClass,
} from '@prisma/client';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';

export function parseExternalId(game: NormalizedGame): string {
    // Our provider APIs currently set ids like "lichess:<id>" and "chesscom:<uuid>"
    const raw = game.id ?? '';
    const idx = raw.indexOf(':');
    return idx >= 0 ? raw.slice(idx + 1) : raw;
}

export function gameSourceToDb(source: UiGameSource): GameSource {
    switch (source) {
        case 'lichess':
            return 'LICHESS';
        case 'chesscom':
            return 'CHESSCOM';
        case 'manual_pgn':
            return 'MANUAL_PGN';
        case 'backranq_coach':
            return 'BACKRANQ_COACH';
    }
}

export function gameSourceToUi(source: GameSource): UiGameSource {
    switch (source) {
        case 'LICHESS':
            return 'lichess';
        case 'CHESSCOM':
            return 'chesscom';
        case 'MANUAL_PGN':
            return 'manual_pgn';
        case 'BACKRANQ_COACH':
            return 'backranq_coach';
    }
}

export function syncProviderToDb(provider: UiSyncProvider): SyncProvider {
    return provider === 'lichess' ? 'LICHESS' : 'CHESSCOM';
}

export function syncProviderToUi(provider: SyncProvider): UiSyncProvider {
    return provider === 'LICHESS' ? 'lichess' : 'chesscom';
}

export function timeClassToDb(t: UiTimeClass): TimeClass {
    switch (t) {
        case 'bullet':
            return 'BULLET';
        case 'blitz':
            return 'BLITZ';
        case 'rapid':
            return 'RAPID';
        case 'classical':
            return 'CLASSICAL';
        default:
            return 'UNKNOWN';
    }
}

export function timeClassToUi(t: TimeClass): UiTimeClass {
    switch (t) {
        case 'BULLET':
            return 'bullet';
        case 'BLITZ':
            return 'blitz';
        case 'RAPID':
            return 'rapid';
        case 'CLASSICAL':
            return 'classical';
        default:
            return 'unknown';
    }
}

export function gameAnalysisToJson(analysis: GameAnalysis): unknown {
    return analysis as unknown;
}

export function jsonToGameAnalysis(json: unknown): GameAnalysis | null {
    if (!json || typeof json !== 'object') return null;
    return json as GameAnalysis;
}

export function normalizedGameToDb(game: NormalizedGame, userId: string) {
    const opening = classifyOpeningFromPgn(game.pgn);
    const timeControl = game.provenance?.timeControl;
    const provenance = resolveGameAnalysisProvenance(game);
    if (!provenance) {
        throw new Error('Game has invalid immutable source provenance');
    }
    return {
        userId,
        provider: gameSourceToDb(game.provider),
        externalId: parseExternalId(game),
        url: game.url ?? null,
        pgn: game.pgn,
        sourcePgnHash: hashSourcePgn(game.pgn),
        sourceUsername: provenance.sourceUsername,
        sourceAccountId: game.provenance?.accountId ?? null,
        userSide: provenance.userSide === 'white' ? ('WHITE' as const) : ('BLACK' as const),
        playedAt: new Date(game.playedAt),
        timeClass: timeClassToDb(game.timeClass),
        timeControlRaw: timeControl?.raw ?? null,
        timeControlInitialSeconds:
            typeof timeControl?.initialSeconds === 'number'
                ? Math.trunc(timeControl.initialSeconds)
                : null,
        timeControlIncrementSeconds:
            typeof timeControl?.incrementSeconds === 'number'
                ? Math.trunc(timeControl.incrementSeconds)
                : null,
        rated: typeof game.rated === 'boolean' ? game.rated : null,
        result: game.result ?? null,
        termination: game.termination ?? null,
        whiteName: game.white.name,
        whiteRating:
            typeof game.white.rating === 'number'
                ? Math.trunc(game.white.rating)
                : null,
        blackName: game.black.name,
        blackRating:
            typeof game.black.rating === 'number'
                ? Math.trunc(game.black.rating)
                : null,
        // opening fields are best-effort derived from PGN headers / small book
        openingEco: opening.eco ?? null,
        openingName: opening.name ?? null,
        openingVariation: opening.variation ?? null,
        analysis: {}, // required by schema; updated later via analysis route
        analyzedAt: null,
    };
}

export function dbGameToNormalized(dbGame: AnalyzedGame): NormalizedGame {
    return {
        id: `${gameSourceToUi(dbGame.provider)}:${dbGame.externalId}`,
        provider: gameSourceToUi(dbGame.provider),
        url: dbGame.url ?? undefined,
        playedAt: dbGame.playedAt.toISOString(),
        timeClass: timeClassToUi(dbGame.timeClass),
        rated: dbGame.rated ?? undefined,
        white: {
            name: dbGame.whiteName,
            rating: dbGame.whiteRating ?? undefined,
        },
        black: {
            name: dbGame.blackName,
            rating: dbGame.blackRating ?? undefined,
        },
        result: dbGame.result ?? undefined,
        termination: dbGame.termination ?? undefined,
        pgn: dbGame.pgn,
        provenance: dbGame.sourceUsername
            ? {
                  username: dbGame.sourceUsername,
                  accountId: dbGame.sourceAccountId ?? undefined,
                  userSide:
                      dbGame.userSide === 'WHITE'
                          ? 'white'
                          : dbGame.userSide === 'BLACK'
                            ? 'black'
                            : 'unknown',
                  timeControl:
                      dbGame.timeControlRaw != null ||
                      dbGame.timeControlInitialSeconds != null ||
                      dbGame.timeControlIncrementSeconds != null
                          ? {
                                raw: dbGame.timeControlRaw ?? undefined,
                                initialSeconds:
                                    dbGame.timeControlInitialSeconds ??
                                    undefined,
                                incrementSeconds:
                                    dbGame.timeControlIncrementSeconds ??
                                    undefined,
                            }
                          : undefined,
              }
            : undefined,
    };
}
