import Link from 'next/link';

export type GameHeaderData = {
    provider: 'LICHESS' | 'CHESSCOM';
    url: string | null;
    playedAt: string; // ISO
    timeClass: 'BULLET' | 'BLITZ' | 'RAPID' | 'CLASSICAL' | 'UNKNOWN';
    rated: boolean | null;
    result: string | null;
    termination: string | null;
    whiteName: string;
    whiteRating: number | null;
    blackName: string;
    blackRating: number | null;
    openingEco: string | null;
    openingName: string | null;
    openingVariation: string | null;
    analyzedAt: string | null;
    accuracy?: { white?: number; black?: number };
};

function timeLabel(tc: GameHeaderData['timeClass']) {
    return tc === 'BULLET'
        ? 'Bullet'
        : tc === 'BLITZ'
          ? 'Blitz'
          : tc === 'RAPID'
            ? 'Rapid'
            : tc === 'CLASSICAL'
              ? 'Classical'
              : 'Unknown';
}

function providerLabel(p: GameHeaderData['provider']) {
    return p === 'LICHESS' ? 'Lichess' : 'Chess.com';
}

export function GameHeader({ game }: { game: GameHeaderData }) {
    const played = new Date(game.playedAt).toLocaleString();
    const opening =
        game.openingName ??
        (game.openingEco ? `${game.openingEco}${game.openingVariation ? ` — ${game.openingVariation}` : ''}` : null);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontWeight: 750 }}>
                        {game.whiteName}
                        {typeof game.whiteRating === 'number' ? ` (${game.whiteRating})` : ''} vs {game.blackName}
                        {typeof game.blackRating === 'number' ? ` (${game.blackRating})` : ''}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {providerLabel(game.provider)} • {timeLabel(game.timeClass)} • {played}
                        {game.rated == null ? '' : game.rated ? ' • Rated' : ' • Casual'}
                        {game.result ? ` • ${game.result}` : ''}
                        {game.termination ? ` • ${game.termination}` : ''}
                    </div>
                    {opening ? (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>📘 {opening}</div>
                    ) : null}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {game.analyzedAt && (game.accuracy?.white != null || game.accuracy?.black != null) ? (
                        <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                            <span style={{ padding: '4px 8px', border: '1px solid var(--border, #e6e6e6)', borderRadius: 999 }}>
                                ♔ {game.accuracy?.white?.toFixed(1) ?? '—'}%
                            </span>
                            <span style={{ padding: '4px 8px', border: '1px solid var(--border, #e6e6e6)', borderRadius: 999 }}>
                                ♚ {game.accuracy?.black?.toFixed(1) ?? '—'}%
                            </span>
                        </div>
                    ) : null}
                    {game.url ? (
                        <Link href={game.url} target="_blank" rel="noreferrer">
                            Open original
                        </Link>
                    ) : null}
                </div>
            </div>
        </div>
    );
}


