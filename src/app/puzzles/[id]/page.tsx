import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { dbToPuzzle, aggregatePuzzleStats } from '@/lib/api/puzzles';
import { PuzzleDetailClient } from '@/components/puzzles/PuzzleDetailClient';
import { PageHeader } from '@/components/app/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';

export default async function PuzzleDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/puzzles');

    const { id } = await params;
    const row = await prisma.puzzle.findFirst({
        where: { id, userId },
        include: {
            game: { select: { provider: true, playedAt: true } },
            attempts: {
                where: { userId },
                orderBy: { attemptedAt: 'desc' },
                select: {
                    id: true,
                    attemptedAt: true,
                    userMoveUci: true,
                    wasCorrect: true,
                    timeSpentMs: true,
                },
            },
        },
    });
    if (!row) notFound();

    const puzzle = dbToPuzzle(row as any);
    const stats = aggregatePuzzleStats(
        row.attempts.map((a) => ({
            wasCorrect: a.wasCorrect,
            attemptedAt: a.attemptedAt,
            timeSpentMs: a.timeSpentMs,
        }))
    );

    // Client component needs an engine reference; PuzzlePanel can create it itself.
    // We provide null engine client and let the panel instantiate via setEngineClient.
    return (
        <div className="space-y-6">
            <PageHeader
                title="Puzzle"
                subtitle="Work through the line, then review your attempts."
                actions={
                    <Button asChild variant="outline">
                        <Link href="/puzzles">Back to trainer</Link>
                    </Button>
                }
            />

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                    <PuzzleDetailClient puzzle={puzzle} />
                </div>

                <aside className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Your stats</CardTitle>
                        </CardHeader>
                        <CardContent className="text-sm text-muted-foreground">
                            <div className="space-y-1">
                                <div>Attempts: {stats.attempted}</div>
                                <div>Correct: {stats.correct}</div>
                                <div>
                                    Success rate:{' '}
                                    {stats.successRate == null
                                        ? '—'
                                        : `${Math.round(stats.successRate * 100)}%`}
                                </div>
                                <div>
                                    Last attempted:{' '}
                                    {stats.lastAttemptedAt
                                        ? new Date(stats.lastAttemptedAt).toLocaleString()
                                        : '—'}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">History</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {row.attempts.length === 0 ? (
                                <div className="text-sm text-muted-foreground">
                                    No attempts yet.
                                </div>
                            ) : (
                                <div className="rounded-md border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Result</TableHead>
                                                <TableHead>Move</TableHead>
                                                <TableHead className="text-right">Time</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {row.attempts.slice(0, 20).map((a) => (
                                                <TableRow key={a.id}>
                                                    <TableCell>
                                                        <Badge
                                                            className={
                                                                a.wasCorrect
                                                                    ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                                    : 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300'
                                                            }
                                                        >
                                                            {a.wasCorrect ? 'Correct' : 'Miss'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="font-mono text-xs">
                                                        {a.userMoveUci}
                                                    </TableCell>
                                                    <TableCell className="text-right text-sm text-muted-foreground">
                                                        {a.timeSpentMs != null
                                                            ? `${Math.round(a.timeSpentMs / 1000)}s`
                                                            : '—'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </aside>
            </div>
        </div>
    );
}

