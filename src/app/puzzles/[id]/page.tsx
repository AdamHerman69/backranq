import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { AppNav } from '@/components/nav/AppNav';
import { prisma } from '@/lib/prisma';
import { dbToPuzzle, aggregatePuzzleStats } from '@/lib/api/puzzles';
import { PuzzleDetailClient } from '@/components/puzzles/PuzzleDetailClient';

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
        <main style={{ padding: 24 }}>
            <AppNav />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, marginTop: 12 }}>
                <div>
                    <PuzzleDetailClient puzzle={puzzle} />
                </div>
                <aside style={{ border: '1px solid var(--border, #e6e6e6)', borderRadius: 12, padding: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 8 }}>Your stats</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Attempts: {stats.attempted}
                        <br />
                        Correct: {stats.correct}
                        <br />
                        Success rate:{' '}
                        {stats.successRate == null ? '—' : `${Math.round(stats.successRate * 100)}%`}
                        <br />
                        Last attempted: {stats.lastAttemptedAt ? new Date(stats.lastAttemptedAt).toLocaleString() : '—'}
                    </div>

                    <div style={{ fontWeight: 800, margin: '14px 0 8px' }}>History</div>
                    {row.attempts.length === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.75 }}>No attempts yet.</div>
                    ) : (
                        <ol style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 16, margin: 0 }}>
                            {row.attempts.slice(0, 20).map((a) => (
                                <li key={a.id} style={{ fontSize: 12 }}>
                                    <span style={{ fontWeight: 800, color: a.wasCorrect ? '#027A48' : '#B42318' }}>
                                        {a.wasCorrect ? 'Correct' : 'Miss'}
                                    </span>
                                    {' • '}
                                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                        {a.userMoveUci}
                                    </span>
                                    {' • '}
                                    <span style={{ opacity: 0.75 }}>
                                        {a.timeSpentMs != null ? `${Math.round(a.timeSpentMs / 1000)}s` : '—'}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}

                    <div style={{ marginTop: 14 }}>
                        <Link href="/puzzles" style={{ textDecoration: 'underline', fontWeight: 650 }}>
                            Back to trainer
                        </Link>
                    </div>
                </aside>
            </div>
        </main>
    );
}

