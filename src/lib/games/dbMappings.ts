import type {
    GameSource,
    SyncProvider,
    TimeClass,
} from '@prisma/client';

import type {
    GameSource as UiGameSource,
    NormalizedGame,
    SyncProvider as UiSyncProvider,
    TimeClass as UiTimeClass,
} from '@/lib/types/game';

export function parseExternalId(game: NormalizedGame): string {
    const raw = game.id ?? '';
    const separator = raw.indexOf(':');
    return separator >= 0 ? raw.slice(separator + 1) : raw;
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

export function timeClassToDb(timeClass: UiTimeClass): TimeClass {
    switch (timeClass) {
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

export function timeClassToUi(timeClass: TimeClass): UiTimeClass {
    switch (timeClass) {
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
