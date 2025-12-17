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
    provider: '' | 'lichess' | 'chesscom';
    timeClass: '' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
    result: '' | 'wins' | 'losses' | 'draws';
    hasAnalysis: '' | 'true' | 'false';
    since: string;
    until: string;
    q: string;
};

export function GamesFilter({
    total,
    initial,
}: {
    total: number;
    initial: GamesFilters;
}) {
    const router = useRouter();
    const pathname = usePathname();

    const [filters, setFilters] = useState<GamesFilters>(initial);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        setFilters(initial);
    }, [initial]);

    // auto-collapse when there are no active filters
    useEffect(() => {
        const hasAny =
            !!filters.provider ||
            !!filters.timeClass ||
            !!filters.result ||
            !!filters.hasAnalysis ||
            !!filters.since ||
            !!filters.until ||
            !!filters.q;
        if (!hasAny) setOpen(false);
    }, [filters]);

    function push(nextFilters: GamesFilters) {
        const next = new URLSearchParams();
        if (nextFilters.provider) next.set('provider', nextFilters.provider);
        if (nextFilters.timeClass) next.set('timeClass', nextFilters.timeClass);
        if (nextFilters.result) next.set('result', nextFilters.result);
        if (nextFilters.hasAnalysis) next.set('hasAnalysis', nextFilters.hasAnalysis);
        if (nextFilters.since) next.set('since', nextFilters.since);
        if (nextFilters.until) next.set('until', nextFilters.until);
        if (nextFilters.q) next.set('q', nextFilters.q);
        router.push(`${pathname}${next.toString() ? `?${next.toString()}` : ''}`);
    }

    function clear() {
        router.push(pathname);
    }

    return (
        <section className="space-y-3">
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
                    <Button type="button" variant="outline" onClick={clear}>
                        Clear
                    </Button>
                </div>
            </div>

            {open ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                    <div className="text-sm font-medium">Provider</div>
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
                        <SelectTrigger>
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="lichess">Lichess</SelectItem>
                            <SelectItem value="chesscom">Chess.com</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">Time class</div>
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
                        <SelectTrigger>
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
                    <div className="text-sm font-medium">Result</div>
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
                        <SelectTrigger>
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
                    <div className="text-sm font-medium">Since</div>
                    <Input
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
                    <div className="text-sm font-medium">Until</div>
                    <Input
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
                    <div className="text-sm font-medium">Analysis</div>
                    <Select
                        value={filters.hasAnalysis || 'all'}
                        onValueChange={(v) => {
                            const next = {
                                ...filters,
                                hasAnalysis: (v === 'all'
                                    ? ''
                                    : (v as GamesFilters['hasAnalysis'])) as GamesFilters['hasAnalysis'],
                            };
                            setFilters(next);
                            push(next);
                        }}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All</SelectItem>
                            <SelectItem value="true">Analyzed</SelectItem>
                            <SelectItem value="false">Not analyzed</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <div className="text-sm font-medium">Search opponent</div>
                    <Input
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


