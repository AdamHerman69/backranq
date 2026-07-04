import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
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
    const view = typeof sp.view === 'string' ? sp.view : '';
    const initialViewMode = view === 'analyze' ? 'analyze' : 'solve';

    return (
        <PuzzleTrainer initialViewMode={initialViewMode} />
    );
}

