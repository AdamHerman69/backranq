'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type PuzzleListItem = {
    id: string;
    title: string;
    subtitle: string;
    status: 'new' | 'failed' | 'solved' | 'attempted';
    tags: string[];
};

function statusLabel(s: PuzzleListItem['status']) {
    if (s === 'solved') return { text: 'Solved', color: '#027A48', bg: 'rgba(2,122,72,0.10)' };
    if (s === 'failed') return { text: 'Failed', color: '#B42318', bg: 'rgba(180,35,24,0.08)' };
    if (s === 'attempted') return { text: 'Attempted', color: '#6941C6', bg: 'rgba(105,65,198,0.10)' };
    return { text: 'New', color: '#344054', bg: 'rgba(52,64,84,0.08)' };
}

function statusBadgeClass(s: PuzzleListItem['status']) {
    if (s === 'solved') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    if (s === 'failed') return 'bg-red-500/15 text-red-700 dark:text-red-300';
    if (s === 'attempted') return 'bg-violet-500/15 text-violet-700 dark:text-violet-300';
    return 'bg-muted text-muted-foreground';
}

export function PuzzlesList({
    puzzles,
    total,
    page,
    totalPages,
    baseQueryString,
}: {
    puzzles: PuzzleListItem[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
}) {
    function pageHref(nextPage: number) {
        const qs = baseQueryString ? `${baseQueryString}&page=${nextPage}` : `page=${nextPage}`;
        return `/puzzles/library?${qs}`;
    }

    if (puzzles.length === 0) {
        return (
            <div className="text-sm text-muted-foreground">
                No puzzles match your filters.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
                Showing page {page} of {totalPages} • {total} total
            </div>

            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Puzzle</TableHead>
                            <TableHead className="w-[110px]">Status</TableHead>
                            <TableHead className="hidden lg:table-cell">Tags</TableHead>
                            <TableHead className="w-[90px] text-right">Open</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {puzzles.map((p) => {
                            const badge = statusLabel(p.status);
                            return (
                                <TableRow key={p.id}>
                                    <TableCell>
                                        <div className="font-medium">{p.title}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {p.subtitle}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge
                                            className={cn(
                                                'border-transparent',
                                                statusBadgeClass(p.status)
                                            )}
                                        >
                                            {badge.text}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="hidden lg:table-cell">
                                        {p.tags.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5">
                                                {p.tags.slice(0, 6).map((t) => (
                                                    <Badge key={t} variant="outline">
                                                        {t}
                                                    </Badge>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-sm text-muted-foreground">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button asChild variant="outline" size="sm">
                                            <Link href={`/puzzles?puzzleId=${encodeURIComponent(p.id)}`}>Open</Link>
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

            <div className="flex items-center justify-between gap-3">
                {page <= 1 ? (
                    <Button variant="outline" disabled>
                        Prev
                    </Button>
                ) : (
                    <Button asChild variant="outline">
                        <Link href={pageHref(page - 1)}>Prev</Link>
                    </Button>
                )}
                <div className="text-sm text-muted-foreground">
                    Page {page} / {totalPages}
                </div>
                {page >= totalPages ? (
                    <Button variant="outline" disabled>
                        Next
                    </Button>
                ) : (
                    <Button asChild variant="outline">
                        <Link href={pageHref(page + 1)}>Next</Link>
                    </Button>
                )}
            </div>
        </div>
    );
}

