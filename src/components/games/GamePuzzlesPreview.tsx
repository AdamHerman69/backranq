import Link from 'next/link';

export type GamePuzzleRow = {
    id: string;
    sourcePly: number;
    type: string;
    bestMoveUci: string;
};

export function GamePuzzlesPreview({
    puzzles,
}: {
    puzzles: GamePuzzleRow[];
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 750 }}>
                    Puzzles from this game ({puzzles.length})
                </div>
                {puzzles.length > 0 ? <Link href="/puzzles">Train</Link> : null}
            </div>

            {puzzles.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                    No puzzles saved for this game yet.
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                    {puzzles.map((p) => (
                        <div
                            key={p.id}
                            style={{
                                border: '1px solid var(--border, #e6e6e6)',
                                borderRadius: 12,
                                padding: 12,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                            }}
                        >
                            <div style={{ fontSize: 12, opacity: 0.8 }}>
                                Ply {p.sourcePly + 1} • {p.type}
                            </div>
                            <div style={{ fontWeight: 750, fontFamily: 'var(--font-geist-mono)' }}>
                                {p.bestMoveUci}
                            </div>
                            <Link href="/puzzles" style={{ fontSize: 12 }}>
                                Train →
                            </Link>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}


