import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PageHeader } from '@/components/app/PageHeader';
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
    const mode = typeof sp.mode === 'string' ? sp.mode : '';
    const view = typeof sp.view === 'string' ? sp.view : '';
    const initialQueueMode = mode === 'review' ? 'reviewFailed' : 'quick';
    const initialViewMode = view === 'analyze' ? 'analyze' : 'solve';

    return (
        <div className="space-y-6">
            <PageHeader
                title="Train"
                subtitle="Quick puzzles or review the ones you missed."
            />
            <PuzzleTrainerV2
                initialQueueMode={initialQueueMode}
                initialViewMode={initialViewMode}
            />
        </div>
    );
}

