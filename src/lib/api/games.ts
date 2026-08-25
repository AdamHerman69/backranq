import type {
    NormalizedGame,
} from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { AnalyzedGame } from '@prisma/client';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';
import { countSourcePgnPlies, hashSourcePgn } from '@/lib/chess/pgn';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import {
    gameSourceToDb,
    gameSourceToUi,
    parseExternalId,
    timeClassToDb,
    timeClassToUi,
} from '@/lib/games/dbMappings';

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
        plyCount: countSourcePgnPlies(game.pgn),
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
