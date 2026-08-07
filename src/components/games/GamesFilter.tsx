'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

export type GamesFilters = {
    provider:
        | ''
        | 'lichess'
        | 'chesscom'
        | 'manual_pgn'
        | 'backranq_coach';
    timeClass: '' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
    result: '' | 'wins' | 'losses' | 'draws';
    analysisState: '' | 'analyzed' | 'needs-analysis';
    positions: '' | 'has';
    since: string;
    until: string;
    q: string;
};

export function GamesFilter({
    total,
    initial,
    selectionMode = false,
    onSelectionModeChange,
}: {
    total: number;
    initial: GamesFilters;
    selectionMode?: boolean;
    onSelectionModeChange?: (active: boolean) => void;
}) {
    const router = useRouter();
    const pathname = usePathname();

    const [filters, setFilters] = useState<GamesFilters>(initial);
    const [open, setOpen] = useState(false);
    const hasAnyFilter = Boolean(
        filters.provider ||
            filters.timeClass ||
            filters.result ||
            filters.analysisState ||
            filters.positions ||
            filters.since ||
            filters.until ||
            filters.q
    );
    const hasAdvancedFilter = Boolean(
        filters.provider ||
            filters.timeClass ||
            filters.result ||
            filters.since ||
            filters.until ||
            filters.q
    );

    useEffect(() => {
        setFilters(initial);
    }, [initial]);

    // auto-collapse when there are no active filters
    useEffect(() => {
        if (hasAdvancedFilter) setOpen(true);
        else if (!hasAnyFilter) setOpen(false);
    }, [hasAdvancedFilter, hasAnyFilter]);

    function push(nextFilters: GamesFilters) {
        const next = new URLSearchParams();
        if (nextFilters.provider) next.set('provider', nextFilters.provider);
        if (nextFilters.timeClass) next.set('timeClass', nextFilters.timeClass);
        if (nextFilters.result) next.set('result', nextFilters.result);
        if (nextFilters.analysisState) {
            next.set('analysisState', nextFilters.analysisState);
        }
        if (nextFilters.positions) next.set('positions', nextFilters.positions);
        if (nextFilters.since) next.set('since', nextFilters.since);
        if (nextFilters.until) next.set('until', nextFilters.until);
        if (nextFilters.q) next.set('q', nextFilters.q);
        router.push(`${pathname}${next.toString() ? `?${next.toString()}` : ''}`);
    }

    function clear() {
        router.push(pathname);
    }

    return (
        <section className="space-y-3" aria-label="Game library controls">
            <div className="flex gap-2 overflow-x-auto pb-1">
                {[
                    {
                        label: 'All games',
                        active: !filters.analysisState && !filters.positions,
                        next: {
                            ...filters,
                            analysisState: '' as const,
                            positions: '' as const,
                        },
                    },
                    {
                        label: 'Needs analysis',
                        active: filters.analysisState === 'needs-analysis',
                        next: {
                            ...filters,
                            analysisState: 'needs-analysis' as const,
                            positions: '' as const,
                        },
                    },
                    {
                        label: 'Has positions',
                        active: filters.positions === 'has',
                        next: {
                            ...filters,
                            analysisState: '' as const,
                            positions: 'has' as const,
                        },
                    },
                ].map((item) => (
                    <Button
                        key={item.label}
                        type="button"
                        size="sm"
                        variant={item.active ? 'secondary' : 'ghost'}
                        className="shrink-0 rounded-full"
                        onClick={() => {
                            setFilters(item.next);
                            push(item.next);
                        }}
                    >
                        {item.label}
                    </Button>
                ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">{total} games</div>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => setOpen((v) => !v)}
                    >
                        {open ? 'Hide filters' : 'Show filters'}
                    </Button>
                    {hasAnyFilter ? (
                        <Button type="button" variant="outline" onClick={clear}>
                            Clear
                        </Button>
                    ) : null}
                    {onSelectionModeChange ? (
                        <Button
                            type="button"
                            variant={selectionMode ? 'secondary' : 'ghost'}
                            onClick={() => onSelectionModeChange(!selectionMode)}
                        >
                            {selectionMode ? 'Done selecting' : 'Select games'}
                        </Button>
                    ) : null}
                </div>
            </div>

            {open ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                    <div
                        id="games-provider-label"
                        className="text-sm font-medium"
                    >
                        Source
                    </div>
                    <Select
                        value={filters.provider || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                provider: (v === 'all'
                                    ? ''
                                    : (v as GamesFilters['provider'])) as GamesFilters['provider'],
                            };
                            setFilters(next);
                            push(next);
                        }}
                    >
                        <SelectTrigger aria-labelledby="games-provider-label">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="lichess">Lichess</SelectItem>
                            <SelectItem value="chesscom">Chess.com</SelectItem>
                            <SelectItem value="manual_pgn">Manual PGN</SelectItem>
                            <SelectItem value="backranq_coach">Backranq Coach</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div
                        id="games-time-class-label"
                        className="text-sm font-medium"
                    >
                        Time class
                    </div>
                    <Select
                        value={filters.timeClass || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                timeClass: (v === 'all'
                                    ? ''
                                    : (v as GamesFilters['timeClass'])) as GamesFilters['timeClass'],
                            };
                            setFilters(next);
                            push(next);
                        }}
                    >
                        <SelectTrigger aria-labelledby="games-time-class-label">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="bullet">Bullet</SelectItem>
                            <SelectItem value="blitz">Blitz</SelectItem>
                            <SelectItem value="rapid">Rapid</SelectItem>
                            <SelectItem value="classical">Classical</SelectItem>
                            <SelectItem value="unknown">Unknown</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div
                        id="games-result-label"
                        className="text-sm font-medium"
                    >
                        Result
                    </div>
                    <Select
                        value={filters.result || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                result: (v === 'all'
                                    ? ''
                                    : (v as GamesFilters['result'])) as GamesFilters['result'],
                            };
                            setFilters(next);
                            push(next);
                        }}
                    >
                        <SelectTrigger aria-labelledby="games-result-label">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="wins">Wins</SelectItem>
                            <SelectItem value="losses">Losses</SelectItem>
                            <SelectItem value="draws">Draws</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <label
                        htmlFor="games-since"
                        className="text-sm font-medium"
                    >
                        Since
                    </label>
                    <Input
                        id="games-since"
                        type="date"
                        value={filters.since}
                        onChange={(e) => {
                            const next = { ...filters, since: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                    />
                </div>

                <div className="space-y-2">
                    <label
                        htmlFor="games-until"
                        className="text-sm font-medium"
                    >
                        Until
                    </label>
                    <Input
                        id="games-until"
                        type="date"
                        value={filters.until}
                        onChange={(e) => {
                            const next = { ...filters, until: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                    />
                </div>

                <div className="space-y-2">
                    <div
                        id="games-analysis-label"
                        className="text-sm font-medium"
                    >
                        Analysis
                    </div>
                    <Select
                        value={filters.analysisState || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                analysisState: (v === 'all'
                                    ? ''
                                    : (v as GamesFilters['analysisState'])) as GamesFilters['analysisState'],
                            };
                            setFilters(next);
                            push(next);
                        }}
                    >
                        <SelectTrigger aria-labelledby="games-analysis-label">
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="analyzed">Analyzed</SelectItem>
                            <SelectItem value="needs-analysis">
                                Needs analysis
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <label
                        htmlFor="games-opponent"
                        className="text-sm font-medium"
                    >
                        Search opponent
                    </label>
                    <Input
                        id="games-opponent"
                        value={filters.q}
                        onChange={(e) => {
                            const next = { ...filters, q: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        placeholder="Opponent name…"
                    />
                </div>
            </div>
            ) : null}

        </section>
    );
}
