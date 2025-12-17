import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
                                        {p.bestMoveUci}
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


