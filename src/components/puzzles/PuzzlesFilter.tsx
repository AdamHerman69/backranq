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

export type PuzzlesFilters = {
    type: '' | 'avoidBlunder' | 'punishBlunder';
    opening: string;
    tags: string; // comma-separated
    status: '' | 'solved' | 'failed' | 'attempted';
    gameId: string;
};

export function PuzzlesFilter({
    total,
    initial,
}: {
    total: number;
    initial: PuzzlesFilters;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const [filters, setFilters] = useState<PuzzlesFilters>(initial);

    useEffect(() => {
        setFilters(initial);
    }, [initial]);

    function push(next: PuzzlesFilters) {
        const p = new URLSearchParams();
        if (next.type) p.set('type', next.type);
        if (next.opening) p.set('opening', next.opening);
        if (next.tags) p.set('tags', next.tags);
        if (next.gameId) p.set('gameId', next.gameId);

        if (next.status === 'solved') p.set('solved', 'true');
        else if (next.status === 'failed') p.set('failed', 'true');
        else if (next.status === 'attempted') {
            p.set('solved', 'true');
            p.set('failed', 'true');
        }

        router.push(`${pathname}${p.toString() ? `?${p.toString()}` : ''}`);
    }

    return (
        <section className="space-y-4">
            <div className="text-sm text-muted-foreground">{total} puzzles</div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                            push(next);
                        }}
                    >
                        <SelectTrigger>
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
                            push(next);
                        }}
                    >
                        <SelectTrigger>
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
                            push(next);
                        }}
                        placeholder="(optional)"
                    />
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <div className="text-sm font-medium">Opening (ECO/name/variation)</div>
                    <Input
                        value={filters.opening}
                        onChange={(e) => {
                            const next = { ...filters, opening: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        placeholder="e.g. C50, Italian, Morphy…"
                    />
                </div>

                <div className="space-y-2 sm:col-span-2 lg:col-span-3">
                    <div className="text-sm font-medium">Tags (comma-separated)</div>
                    <Input
                        value={filters.tags}
                        onChange={(e) => {
                            const next = { ...filters, tags: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        placeholder="e.g. punishBlunder, eco:C50, mateThreat…"
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => router.push(pathname)}>
                    Clear filters
                </Button>
            </div>
        </section>
    );
}

