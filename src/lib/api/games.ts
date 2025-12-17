import type {
    NormalizedGame,
    Provider as UiProvider,
    TimeClass as UiTimeClass,
} from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { AnalyzedGame, Provider, TimeClass } from '@prisma/client';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';

export function parseExternalId(game: NormalizedGame): string {
    // Our provider APIs currently set ids like "lichess:<id>" and "chesscom:<uuid>"
    const raw = game.id ?? '';
    const idx = raw.indexOf(':');
    return idx >= 0 ? raw.slice(idx + 1) : raw;
}

export function providerToDb(p: UiProvider): Provider {
    return p === 'lichess' ? 'LICHESS' : 'CHESSCOM';
}

export function providerToUi(p: Provider): UiProvider {
    return p === 'LICHESS' ? 'lichess' : 'chesscom';
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
    return {
        userId,
        provider: providerToDb(game.provider),
        externalId: parseExternalId(game),
        url: game.url ?? null,
        pgn: game.pgn,
        playedAt: new Date(game.playedAt),
        timeClass: timeClassToDb(game.timeClass),
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
        id: `${providerToUi(dbGame.provider)}:${dbGame.externalId}`,
        provider: providerToUi(dbGame.provider),
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
    };
}
