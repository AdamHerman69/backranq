import type { NormalizedGame } from '@/lib/types/game';

export type ProviderBatchFetchResult = {
    games: NormalizedGame[];
    complete: boolean;
    nextUntil: string | null;
    nextBoundaryIds?: string[];
    etag?: string | null;
    lastModified?: string | null;
};

export function dedupeGames(games: NormalizedGame[]) {
    const byId = new Map<string, NormalizedGame>();
    for (const game of games) {
        if (!byId.has(game.id)) byId.set(game.id, game);
    }
    return Array.from(byId.values()).sort(
        (a, b) =>
            new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
    );
}

/**
 * Keeps a recent-game onboarding cap without splitting a timestamp boundary.
 * The deliberate first-sync cutoff is therefore always strictly older than
 * every returned game.
 */
export function takeRecentWithTimestampBoundary(
    games: NormalizedGame[],
    maxGames: number | undefined
) {
    const sorted = dedupeGames(games);
    if (!maxGames || sorted.length <= maxGames) return sorted;
    const boundary = sorted[maxGames - 1]?.playedAt;
    if (!boundary) return sorted.slice(0, maxGames);
    const boundaryMs = new Date(boundary).getTime();
    return sorted.filter(
        (game) => new Date(game.playedAt).getTime() >= boundaryMs
    );
}

export function previousMillisecond(iso: string) {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return null;
    return new Date(time - 1).toISOString();
}
