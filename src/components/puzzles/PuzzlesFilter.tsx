'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

export type PuzzlesFilters = {
    type: '' | 'avoidBlunder' | 'punishBlunder';
    kind: '' | 'blunder' | 'missedWin' | 'missedTactic';
    phase: '' | 'opening' | 'middlegame' | 'endgame';
    multiSolution: '' | 'any' | 'single' | 'multi';
    openingEco: string[]; // ECO codes
    tags: string[]; // tag names
    status: '' | 'solved' | 'failed' | 'attempted';
    gameId: string;
};

export function PuzzlesFilter({
    total,
    initial,
    preserveKeys,
    autoApply,
}: {
    total?: number;
    initial: PuzzlesFilters;
    preserveKeys?: string[];
    autoApply?: boolean;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const [filters, setFilters] = useState<PuzzlesFilters>(initial);
    const [openingOptions, setOpeningOptions] = useState<MultiSelectOption[]>([]);
    const [tagOptions, setTagOptions] = useState<MultiSelectOption[]>([]);

    const isAutoApply = autoApply ?? true;

    useEffect(() => {
        setFilters(initial);
    }, [initial]);

    useEffect(() => {
        let cancelled = false;
        async function run() {
            try {
                const res = await fetch('/api/puzzles/facets?limit=500');
                const json = (await res.json().catch(() => ({}))) as {
                    openings?: MultiSelectOption[];
                    tags?: MultiSelectOption[];
                    error?: string;
                };
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to load facets');
                if (cancelled) return;
                setOpeningOptions(
                    Array.isArray(json?.openings) ? json.openings : []
                );
                setTagOptions(Array.isArray(json?.tags) ? json.tags : []);
            } catch {
                if (!cancelled) {
                    setOpeningOptions([]);
                    setTagOptions([]);
                }
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, []);

    const preserveSet = useMemo(() => new Set(preserveKeys ?? []), [preserveKeys]);

    function push(next: PuzzlesFilters) {
        const p = new URLSearchParams();

        // Preserve selected query params (e.g. trainer mode/view) while changing filters.
        if (preserveSet.size > 0 && typeof window !== 'undefined') {
            const cur = new URLSearchParams(window.location.search);
            for (const key of preserveSet) {
                const all = cur.getAll(key);
                for (const v of all) p.append(key, v);
            }
        }

        if (next.type) p.set('type', next.type);
        if (next.kind) p.set('kind', next.kind);
        if (next.phase) p.set('phase', next.phase);
        if (next.multiSolution && next.multiSolution !== 'any')
            p.set('multiSolution', next.multiSolution);
        if (next.openingEco && next.openingEco.length > 0)
            p.set('openingEco', next.openingEco.join(','));
        if (next.tags && next.tags.length > 0) p.set('tags', next.tags.join(','));
        if (next.gameId) p.set('gameId', next.gameId);

        if (next.status === 'solved') p.set('solved', 'true');
        else if (next.status === 'failed') p.set('failed', 'true');
        else if (next.status === 'attempted') {
            p.set('solved', 'true');
            p.set('failed', 'true');
        }

        // If we're not explicitly preserving a specific puzzle selection, drop it.
        if (!preserveSet.has('puzzleId')) p.delete('puzzleId');

        router.push(`${pathname}${p.toString() ? `?${p.toString()}` : ''}`);
    }

    function normalizeForCompare(f: PuzzlesFilters) {
        return {
            ...f,
            openingEco: [...(f.openingEco ?? [])].slice().sort(),
            tags: [...(f.tags ?? [])].slice().sort(),
        };
    }

    const isDirty = useMemo(() => {
        return (
            JSON.stringify(normalizeForCompare(filters)) !==
            JSON.stringify(normalizeForCompare(initial))
        );
    }, [filters, initial]);

    const emptyFilters: PuzzlesFilters = useMemo(
        () => ({
            type: '',
            kind: '',
            phase: '',
            multiSolution: '',
            openingEco: [],
            tags: [],
            status: '',
            gameId: '',
        }),
        []
    );

    return (
        <section className="space-y-4">
            {typeof total === 'number' ? (
                <div className="text-sm text-muted-foreground">
                    {total.toLocaleString()} puzzles
                </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <div className="space-y-2">
                    <div className="text-sm font-medium">Type</div>
                    <Select
                        value={filters.type || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                type: (v === 'all'
                                    ? ''
                                    : (v as PuzzlesFilters['type'])) as PuzzlesFilters['type'],
                            };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                    >
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="avoidBlunder">Avoid blunder</SelectItem>
                            <SelectItem value="punishBlunder">Punish blunder</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Kind</div>
                    <Select
                        value={filters.kind || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                kind: (v === 'all'
                                    ? ''
                                    : (v as PuzzlesFilters['kind'])) as PuzzlesFilters['kind'],
                            };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                    >
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="blunder">Blunder</SelectItem>
                            <SelectItem value="missedWin">Missed win</SelectItem>
                            <SelectItem value="missedTactic">Missed tactic</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Phase</div>
                    <Select
                        value={filters.phase || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                phase: (v === 'all'
                                    ? ''
                                    : (v as PuzzlesFilters['phase'])) as PuzzlesFilters['phase'],
                            };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                    >
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="opening">Opening</SelectItem>
                            <SelectItem value="middlegame">Middlegame</SelectItem>
                            <SelectItem value="endgame">Endgame</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Multi-solution</div>
                    <Select
                        value={filters.multiSolution || 'any'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                multiSolution: (v as PuzzlesFilters['multiSolution']) ?? 'any',
                            };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                    >
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Any" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="any">Any</SelectItem>
                            <SelectItem value="single">Single</SelectItem>
                            <SelectItem value="multi">Multi</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Status</div>
                    <Select
                        value={filters.status || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                status: (v === 'all'
                                    ? ''
                                    : (v as PuzzlesFilters['status'])) as PuzzlesFilters['status'],
                            };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                    >
                        <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="solved">Solved</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                            <SelectItem value="attempted">Attempted (any)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Game ID</div>
                    <Input
                        value={filters.gameId}
                        onChange={(e) => {
                            const next = { ...filters, gameId: e.target.value };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                        placeholder="(optional)"
                        className="h-8 text-xs"
                    />
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <div className="text-sm font-medium">Openings (ECO)</div>
                    <MultiSelect
                        options={openingOptions}
                        value={filters.openingEco ?? []}
                        onChange={(openingEco) => {
                            const next = { ...filters, openingEco };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                        placeholder="Any opening"
                        searchPlaceholder="Search openings…"
                        triggerClassName="h-8 text-xs"
                    />
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <div className="text-sm font-medium">Tags</div>
                    <MultiSelect
                        options={tagOptions}
                        value={filters.tags ?? []}
                        onChange={(tags) => {
                            const next = { ...filters, tags };
                            setFilters(next);
                            if (isAutoApply) push(next);
                        }}
                        placeholder="Any tag"
                        searchPlaceholder="Search tags…"
                        triggerClassName="h-8 text-xs"
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                {!isAutoApply ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => push(filters)}
                            disabled={!isDirty}
                        >
                            Apply filters
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setFilters(initial)}
                            disabled={!isDirty}
                        >
                            Reset
                        </Button>
                    </>
                ) : null}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setFilters(emptyFilters);
                        // In manual mode, clearing should apply immediately (it's a deliberate action).
                        push(emptyFilters);
                    }}
                >
                    Clear filters
                </Button>
            </div>
        </section>
    );
}

export default PuzzlesFilter;

