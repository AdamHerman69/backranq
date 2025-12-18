import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { aggregatePuzzleStats } from '@/lib/api/puzzles';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import { PuzzlesList, type PuzzleListItem } from '@/components/puzzles/PuzzlesList';
import { PageHeader } from '@/components/app/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

function stripLegacyPseudoTags(tags: string[]): string[] {
    return tags.filter((t) => {
        if (!t) return false;
        if (t === 'avoidBlunder' || t === 'punishBlunder') return false;
        if (t.startsWith('kind:')) return false;
        if (t.startsWith('eco:')) return false;
        if (t.startsWith('opening:')) return false;
        if (t.startsWith('openingVar:')) return false;
        return true;
    });
}

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function parseBool(v: string | undefined): boolean | null {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
}

function parseCsv(v: string, max: number): string[] {
    const s = (v ?? '').trim();
    if (!s) return [];
    return s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, max);
}

export default async function PuzzleLibraryPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/puzzles/library');

    const sp = (await searchParams) ?? {};
    const page = clampInt(Number(sp.page ?? 1) || 1, 1, 100_000);
    const limit = clampInt(Number(sp.limit ?? 20) || 20, 1, 50);
    const type = typeof sp.type === 'string' ? sp.type : '';
    const kind = typeof sp.kind === 'string' ? sp.kind : '';
    const phase = typeof sp.phase === 'string' ? sp.phase : '';
    const opening = typeof sp.opening === 'string' ? sp.opening.trim() : ''; // legacy free-text
    const openingEcoParam = typeof sp.openingEco === 'string' ? sp.openingEco.trim() : '';
    const tagsParam = typeof sp.tags === 'string' ? sp.tags.trim() : '';
    const gameId = typeof sp.gameId === 'string' ? sp.gameId.trim() : '';
    const multiSolution =
        typeof sp.multiSolution === 'string' ? sp.multiSolution.trim() : '';
    const solved = parseBool(typeof sp.solved === 'string' ? sp.solved : undefined);
    const failed = parseBool(typeof sp.failed === 'string' ? sp.failed : undefined);

    const tags = parseCsv(tagsParam, 16);
    const openingEco = parseCsv(openingEcoParam, 32).map((s) => s.toUpperCase());

    const where: Prisma.PuzzleWhereInput = { userId };
    const and: Prisma.PuzzleWhereInput[] = [];
    if (type === 'avoidBlunder') where.type = 'AVOID_BLUNDER';
    if (type === 'punishBlunder') where.type = 'PUNISH_BLUNDER';
    if (kind === 'blunder') where.kind = 'BLUNDER';
    if (kind === 'missedWin') where.kind = 'MISSED_WIN';
    if (kind === 'missedTactic') where.kind = 'MISSED_TACTIC';
    if (phase === 'opening') where.phase = 'OPENING';
    if (phase === 'middlegame') where.phase = 'MIDDLEGAME';
    if (phase === 'endgame') where.phase = 'ENDGAME';
    if (gameId) where.gameId = gameId;

    if (multiSolution === 'multi') {
        const need = Array.from(new Set([...tags, 'multiSolution'])).slice(0, 16);
        if (need.length > 0) where.tags = { hasEvery: need };
    } else if (tags.length > 0) {
        where.tags = { hasEvery: tags };
    }

    if (multiSolution === 'single') {
        and.push({ NOT: { tags: { has: 'multiSolution' } } });
    }

    if (openingEco.length > 0) {
        where.openingEco = { in: openingEco };
    } else if (opening) {
        where.OR = [
            { openingEco: { contains: opening, mode: 'insensitive' } },
            { openingName: { contains: opening, mode: 'insensitive' } },
            { openingVariation: { contains: opening, mode: 'insensitive' } },
        ];
    }
    if (solved === true && failed === true) {
        where.attempts = { some: { userId } };
    } else if (solved === true) {
        where.attempts = { some: { userId, wasCorrect: true } };
    } else if (failed === true) {
        where.attempts = { some: { userId } };
        and.push({ NOT: { attempts: { some: { userId, wasCorrect: true } } } });
    }

    if (and.length > 0) where.AND = and;

    const [total, rows] = await Promise.all([
        prisma.puzzle.count({ where }),
        prisma.puzzle.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                sourcePly: true,
                openingEco: true,
                openingName: true,
                openingVariation: true,
                type: true,
                kind: true,
                phase: true,
                createdAt: true,
                tags: true,
                attempts: {
                    where: { userId },
                    select: { wasCorrect: true, attemptedAt: true, timeSpentMs: true },
                    orderBy: { attemptedAt: 'desc' },
                },
            },
        }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    const listItems: PuzzleListItem[] = rows.map((p) => {
        const stats = aggregatePuzzleStats(p.attempts);
        const status: PuzzleListItem['status'] = stats.attempted === 0 ? 'new' : stats.solved ? 'solved' : stats.failed ? 'failed' : 'attempted';
        const title = `${p.openingEco ? `${p.openingEco} ` : ''}${p.openingName ?? 'Puzzle'}`.trim();
        const modeText =
            p.type === 'PUNISH_BLUNDER'
                ? 'Punish blunder'
                : p.type === 'AVOID_BLUNDER'
                  ? 'Avoid blunder'
                  : String(p.type);
        const kindText =
            p.kind === 'MISSED_WIN'
                ? 'Missed win'
                : p.kind === 'MISSED_TACTIC'
                  ? 'Missed tactic'
                  : 'Blunder';
        const phaseText =
            p.phase === 'OPENING'
                ? 'Opening'
                : p.phase === 'MIDDLEGAME'
                  ? 'Middlegame'
                  : p.phase === 'ENDGAME'
                    ? 'Endgame'
                    : '';
        const subtitle = `${modeText} • ${kindText}${phaseText ? ` • ${phaseText}` : ''} • ply ${p.sourcePly + 1} • ${p.createdAt.toLocaleDateString()}`;
        return {
            id: p.id,
            title,
            subtitle,
            status,
            tags: Array.isArray(p.tags)
                ? stripLegacyPseudoTags(p.tags).slice(0, 12)
                : [],
        };
    });

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
        openingEco,
        tags,
        gameId,
        status: solved === true && failed === true ? 'attempted' : solved === true ? 'solved' : failed === true ? 'failed' : '',
    };

    const baseQueryString = (() => {
        const p = new URLSearchParams();
        if (initialFilters.type) p.set('type', initialFilters.type);
        if (initialFilters.kind) p.set('kind', initialFilters.kind);
        if (initialFilters.phase) p.set('phase', initialFilters.phase);
        if (initialFilters.multiSolution && initialFilters.multiSolution !== 'any')
            p.set('multiSolution', initialFilters.multiSolution);
        if (initialFilters.openingEco.length > 0)
            p.set('openingEco', initialFilters.openingEco.join(','));
        if (initialFilters.tags.length > 0) p.set('tags', initialFilters.tags.join(','));
        if (initialFilters.gameId) p.set('gameId', initialFilters.gameId);
        if (initialFilters.status === 'solved') p.set('solved', 'true');
        else if (initialFilters.status === 'failed') p.set('failed', 'true');
        else if (initialFilters.status === 'attempted') {
            p.set('solved', 'true');
            p.set('failed', 'true');
        }
        if (limit !== 20) p.set('limit', String(limit));
        return p.toString();
    })();

    return (
        <div className="space-y-6">
            <PageHeader
                title="Puzzles"
                subtitle="Filter by opening and tags, then drill into a single puzzle."
                actions={
                    <Button asChild variant="outline">
                        <Link href="/puzzles">Back to trainer</Link>
                    </Button>
                }
            />

            <Card>
                <CardContent className="pt-6">
                    <PuzzlesFilter total={total} initial={initialFilters} />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
                    {listItems.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                            No puzzles yet — analyze a game first.
                        </div>
                    ) : (
                        <PuzzlesList
                            puzzles={listItems}
                            total={total}
                            page={page}
                            totalPages={totalPages}
                            baseQueryString={baseQueryString}
                        />
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

