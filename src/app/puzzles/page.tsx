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

function describeFilters(f: PuzzlesFilters): string {
    const parts: string[] = [];

    const labelType: Record<PuzzlesFilters['type'], string> = {
        '': '',
        avoidBlunder: 'Avoid blunder',
        punishBlunder: 'Punish blunder',
    };
    const labelKind: Record<PuzzlesFilters['kind'], string> = {
        '': '',
        blunder: 'Blunder',
        missedWin: 'Missed win',
        missedTactic: 'Missed tactic',
    };
    const labelPhase: Record<PuzzlesFilters['phase'], string> = {
        '': '',
        opening: 'Opening',
        middlegame: 'Middlegame',
        endgame: 'Endgame',
    };
    const labelMulti: Record<PuzzlesFilters['multiSolution'], string> = {
        '': '',
        any: 'Any',
        single: 'Single-solution',
        multi: 'Multi-solution',
    };
    const labelStatus: Record<PuzzlesFilters['status'], string> = {
        '': '',
        solved: 'Solved',
        failed: 'Failed',
        attempted: 'Attempted',
    };

    if (f.type) parts.push(`Type: ${labelType[f.type]}`);
    if (f.kind) parts.push(`Kind: ${labelKind[f.kind]}`);
    if (f.phase) parts.push(`Phase: ${labelPhase[f.phase]}`);
    if (f.multiSolution && f.multiSolution !== 'any')
        parts.push(`Solutions: ${labelMulti[f.multiSolution]}`);
    if (f.status) parts.push(`Status: ${labelStatus[f.status]}`);

    if (f.openingEco?.length) {
        const codes = f.openingEco.map((s) => s.toUpperCase());
        const first = codes.slice(0, 2).join(', ');
        parts.push(
            `Openings: ${first}${codes.length > 2 ? ` +${codes.length - 2}` : ''}`
        );
    }
    if (f.tags?.length) {
        const first = f.tags.slice(0, 2).join(', ');
        parts.push(`Tags: ${first}${f.tags.length > 2 ? ` +${f.tags.length - 2}` : ''}`);
    }
    if (f.gameId) parts.push(`Game: ${f.gameId}`);

    return parts.length ? parts.join(' · ') : 'All';
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
    const view = typeof sp.view === 'string' ? sp.view : '';
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
        <div className="space-y-4">
            <PageHeader title="Train" />

            <details className="rounded-lg border bg-card">
                <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                    <span>Filters</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                        {describeFilters(initialFilters)}
                    </span>
                </summary>
                <div className="px-4 pb-4">
                    <PuzzlesFilter
                        initial={initialFilters}
                        preserveKeys={['view']}
                        autoApply={false}
                    />
                </div>
            </details>

            <PuzzleTrainerV2 initialViewMode={initialViewMode} />
        </div>
    );
}

