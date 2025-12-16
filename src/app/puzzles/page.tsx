import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AppNav } from '@/components/nav/AppNav';
import { PuzzleTrainer } from '@/components/puzzles/PuzzleTrainer';

export default async function PuzzlesPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/puzzles');

    const sp = (await searchParams) ?? {};
    const mode = typeof sp.mode === 'string' ? sp.mode : '';
    const trainerMode = mode === 'review' ? 'reviewFailed' : 'quick';

    return (
        <main style={{ padding: 24 }}>
            <AppNav />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <a
                        href="/puzzles?mode=quick"
                        style={{
                            fontWeight: 800,
                            textDecoration: trainerMode === 'quick' ? 'underline' : 'none',
                        }}
                    >
                        Quick Play
                    </a>
                    <a
                        href="/puzzles?mode=review"
                        style={{
                            fontWeight: 800,
                            textDecoration: trainerMode === 'reviewFailed' ? 'underline' : 'none',
                        }}
                    >
                        Review Failed
                    </a>
                </div>

                <PuzzleTrainer mode={trainerMode} />
            </div>
        </main>
    );
}

