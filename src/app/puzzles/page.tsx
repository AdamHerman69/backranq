import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PuzzleTrainerV2 } from '@/components/puzzles/PuzzleTrainerV2';

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
        <PuzzleTrainerV2 initialViewMode={initialViewMode} />
    );
}

