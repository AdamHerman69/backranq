import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { AppNav } from '@/components/nav/AppNav';
import { prisma } from '@/lib/prisma';

export default async function PuzzleLibraryPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/puzzles/library');

    const rows = await prisma.puzzle.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
            id: true,
            sourcePly: true,
            openingEco: true,
            openingName: true,
            type: true,
            createdAt: true,
        },
    });

    return (
        <main style={{ padding: 24 }}>
            <AppNav />
            <h1 style={{ marginTop: 12 }}>Puzzle library</h1>
            <p style={{ opacity: 0.75 }}>
                Showing the most recent 50 puzzles. (We’ll upgrade this to full filters/pagination next.)
            </p>

            {rows.length === 0 ? (
                <div style={{ opacity: 0.75 }}>No puzzles yet — analyze a game first.</div>
            ) : (
                <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 18 }}>
                    {rows.map((p) => (
                        <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <div style={{ fontWeight: 800 }}>
                                    {p.openingEco ? `${p.openingEco} ` : ''}
                                    {p.openingName ?? 'Puzzle'}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.75 }}>
                                    {String(p.type)} • ply {p.sourcePly + 1} •{' '}
                                    {p.createdAt.toLocaleDateString()}
                                </div>
                            </div>
                            <Link href={`/puzzles/${p.id}`} style={{ textDecoration: 'underline', fontWeight: 650 }}>
                                Open →
                            </Link>
                        </li>
                    ))}
                </ol>
            )}

            <div style={{ marginTop: 14 }}>
                <Link href="/puzzles" style={{ textDecoration: 'underline', fontWeight: 650 }}>
                    Back to trainer
                </Link>
            </div>
        </main>
    );
}

