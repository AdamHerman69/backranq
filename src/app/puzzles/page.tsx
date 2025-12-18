import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PageHeader } from '@/components/app/PageHeader';
import { PuzzleTrainerV2 } from '@/components/puzzles/PuzzleTrainerV2';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';

function parseCsv(v: string, max: number): string[] {
    const s = (v ?? '').trim();
    if (!s) return [];
    return s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, max);
}

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

    const type = typeof sp.type === 'string' ? sp.type : '';
    const kind = typeof sp.kind === 'string' ? sp.kind : '';
    const phase = typeof sp.phase === 'string' ? sp.phase : '';
    const gameId = typeof sp.gameId === 'string' ? sp.gameId.trim() : '';
    const tagsParam = typeof sp.tags === 'string' ? sp.tags.trim() : '';
    const openingEcoParam =
        typeof sp.openingEco === 'string' ? sp.openingEco.trim() : '';
    const multiSolution =
        typeof sp.multiSolution === 'string' ? sp.multiSolution.trim() : '';
    const solved = typeof sp.solved === 'string' ? sp.solved : '';
    const failed = typeof sp.failed === 'string' ? sp.failed : '';

    const initialFilters: PuzzlesFilters = {
        type: (type === 'avoidBlunder' || type === 'punishBlunder'
            ? type
            : '') as PuzzlesFilters['type'],
        kind: (kind === 'blunder' || kind === 'missedWin' || kind === 'missedTactic'
            ? kind
            : '') as PuzzlesFilters['kind'],
        phase: (phase === 'opening' || phase === 'middlegame' || phase === 'endgame'
            ? phase
            : '') as PuzzlesFilters['phase'],
        multiSolution:
            multiSolution === 'single' || multiSolution === 'multi'
                ? (multiSolution as PuzzlesFilters['multiSolution'])
                : '',
        openingEco: parseCsv(openingEcoParam, 32).map((s) => s.toUpperCase()),
        tags: parseCsv(tagsParam, 16),
        gameId,
        status:
            solved === 'true' && failed === 'true'
                ? 'attempted'
                : solved === 'true'
                  ? 'solved'
                  : failed === 'true'
                    ? 'failed'
                    : '',
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Train"
                subtitle="Quick puzzles or review the ones you missed."
            />

            <details className="rounded-md border">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
                    Filters
                </summary>
                <div className="px-4 pb-4">
                    <PuzzlesFilter
                        initial={initialFilters}
                        preserveKeys={['mode', 'view']}
                        autoApply={false}
                    />
                </div>
            </details>

            <PuzzleTrainerV2
                initialQueueMode={initialQueueMode}
                initialViewMode={initialViewMode}
            />
        </div>
    );
}

