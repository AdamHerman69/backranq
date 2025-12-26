import Link from 'next/link';
import { useMemo } from 'react';
import { Chess, type Move as VerboseMove } from 'chess.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { extractStartFenFromPgn, uciToSan } from '@/lib/chess/utils';

export type GamePuzzleRow = {
    id: string;
    sourcePly: number;
    type: string;
    bestMoveUci: string;
};

export function GamePuzzlesPreview({
    puzzles,
    pgn,
}: {
    puzzles: GamePuzzleRow[];
    pgn?: string;
}) {
    const bestMoveSanById = useMemo(() => {
        if (!pgn) return new Map<string, string>();
        let verboseMoves: VerboseMove[] = [];
        try {
            const chess = new Chess();
            chess.loadPgn(pgn, { strict: false });
            verboseMoves = chess.history({ verbose: true }) as VerboseMove[];
        } catch {
            return new Map<string, string>();
        }

        const startFen = (() => {
            const fenTag = extractStartFenFromPgn(pgn);
            if (fenTag) return fenTag;
            const c2 = new Chess();
            try {
                c2.loadPgn(pgn, { strict: false });
                while (c2.undo()) {}
                return c2.fen();
            } catch {
                return new Chess().fen();
            }
        })();

        const c = new Chess(startFen);
        const fensByPly: string[] = [c.fen()];
        for (const m of verboseMoves) {
            try {
                const mv = c.move({
                    from: m.from,
                    to: m.to,
                    promotion: (m as unknown as { promotion?: string }).promotion,
                });
                if (!mv) break;
                fensByPly.push(c.fen());
            } catch {
                break;
            }
        }

        const out = new Map<string, string>();
        for (const p of puzzles) {
            const fenBefore = fensByPly[p.sourcePly] ?? startFen;
            const san = uciToSan(fenBefore, p.bestMoveUci) ?? p.bestMoveUci;
            out.set(p.id, san);
        }
        return out;
    }, [pgn, puzzles]);

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                        Puzzles from this game
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                            ({puzzles.length})
                        </span>
                    </CardTitle>
                    {puzzles.length > 0 ? (
                        <Button asChild variant="outline" size="sm">
                            <Link href="/puzzles">Train</Link>
                        </Button>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {puzzles.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                        No puzzles saved for this game yet.
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                        {puzzles.map((p) => (
                            <Card key={p.id} className="shadow-none">
                                <CardContent className="pt-6">
                                    <div className="flex items-center justify-between gap-2">
                                        <Badge variant="secondary">
                                            Ply {p.sourcePly + 1}
                                        </Badge>
                                        <Badge variant="outline">{p.type}</Badge>
                                    </div>
                                    <div className="mt-2 font-mono text-sm font-semibold">
                                        {bestMoveSanById.get(p.id) ?? p.bestMoveUci}
                                    </div>
                                    <div className="mt-3">
                                        <Button asChild variant="outline" size="sm">
                                            <Link href={`/puzzles?puzzleId=${encodeURIComponent(p.id)}`}>Open</Link>
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}


