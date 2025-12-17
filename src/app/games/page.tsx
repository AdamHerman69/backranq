import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { GameCardData } from '@/components/games/GameCard';
import { SyncGamesWidget } from '@/components/sync/SyncGamesWidget';
import type { Prisma } from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { PageHeader } from '@/components/app/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';
import { GamesIndexClient } from '@/components/games/GamesIndexClient';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function normalizeResultFilter(v: string | undefined) {
    if (v === 'wins') return '1-0';
    if (v === 'losses') return '0-1';
    if (v === 'draws') return '1/2-1/2';
    return null;
}

export default async function GamesPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/games');

    const sp = (await searchParams) ?? {};
    const page = clampInt(Number(sp.page ?? 1) || 1, 1, 10_000);
    const limit = clampInt(Number(sp.limit ?? 20) || 20, 1, 50);
    const provider = typeof sp.provider === 'string' ? sp.provider : '';
    const timeClass = typeof sp.timeClass === 'string' ? sp.timeClass : '';
    const resultParam = typeof sp.result === 'string' ? sp.result : '';
    const resultFilter = normalizeResultFilter(
        typeof sp.result === 'string' ? sp.result : undefined
    );
    const since = typeof sp.since === 'string' ? sp.since : '';
    const until = typeof sp.until === 'string' ? sp.until : '';
    const hasAnalysis = typeof sp.hasAnalysis === 'string' ? sp.hasAnalysis : '';
    const q = typeof sp.q === 'string' ? sp.q.trim() : '';

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            lichessUsername: true,
            chesscomUsername: true,
        },
    });

    const where: Prisma.AnalyzedGameWhereInput = { userId };
    if (provider === 'lichess') where.provider = 'LICHESS';
    if (provider === 'chesscom') where.provider = 'CHESSCOM';
    if (
        timeClass === 'bullet' ||
        timeClass === 'blitz' ||
        timeClass === 'rapid' ||
        timeClass === 'classical' ||
        timeClass === 'unknown'
    ) {
        where.timeClass =
            timeClass === 'bullet'
                ? 'BULLET'
                : timeClass === 'blitz'
                  ? 'BLITZ'
                  : timeClass === 'rapid'
                    ? 'RAPID'
                    : timeClass === 'classical'
                      ? 'CLASSICAL'
                      : 'UNKNOWN';
    }
    if (resultFilter) where.result = resultFilter;
    if (hasAnalysis === 'true') where.analyzedAt = { not: null };
    if (hasAnalysis === 'false') where.analyzedAt = null;
    if (q) {
        where.OR = [
            { whiteName: { contains: q, mode: 'insensitive' } },
            { blackName: { contains: q, mode: 'insensitive' } },
        ];
    }
    if (since) {
        const d = new Date(since);
        if (!Number.isNaN(d.getTime())) {
            where.playedAt = { ...(where.playedAt as any), gte: d };
        }
    }
    if (until) {
        const d = new Date(until);
        if (!Number.isNaN(d.getTime())) {
            where.playedAt = { ...(where.playedAt as any), lte: d };
        }
    }

    const [total, rows] = await Promise.all([
        prisma.analyzedGame.count({ where }),
        prisma.analyzedGame.findMany({
            where,
            orderBy: { playedAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                provider: true,
                playedAt: true,
                timeClass: true,
                rated: true,
                result: true,
                termination: true,
                whiteName: true,
                whiteRating: true,
                blackName: true,
                blackRating: true,
                pgn: true,
                openingEco: true,
                openingName: true,
                openingVariation: true,
                analyzedAt: true,
                analysis: true,
            },
        }),
    ]);

    // Backfill opening fields if missing (older imported games)
    const toBackfill = rows
        .filter((g) => !g.openingEco && !g.openingName && g.pgn)
        .map((g) => {
            const o = classifyOpeningFromPgn(g.pgn);
            if (!o.eco && !o.name && !o.variation) return null;
            if (o.source === 'unknown') return null;
            return { id: g.id, eco: o.eco ?? null, name: o.name ?? null, variation: o.variation ?? null };
        })
        .filter(Boolean) as { id: string; eco: string | null; name: string | null; variation: string | null }[];

    if (toBackfill.length > 0) {
        await prisma.$transaction(
            toBackfill.map((u) =>
                prisma.analyzedGame.update({
                    where: { id: u.id },
                    data: { openingEco: u.eco, openingName: u.name, openingVariation: u.variation },
                })
            )
        );
    }

    const puzzlesByGameId = (() => new Map<string, { id: string; sourcePly: number; type: 'AVOID_BLUNDER' | 'PUNISH_BLUNDER' }[]>())();
    if (rows.length > 0) {
        const gameIds = rows.map((g) => g.id);
        const puzzleRows = await prisma.puzzle.findMany({
            where: { userId, gameId: { in: gameIds } },
            orderBy: { sourcePly: 'asc' },
            select: { id: true, gameId: true, sourcePly: true, type: true },
        });
        for (const p of puzzleRows) {
            const list = puzzlesByGameId.get(p.gameId) ?? [];
            list.push({
                id: p.id,
                sourcePly: p.sourcePly,
                type: p.type,
            });
            puzzlesByGameId.set(p.gameId, list);
        }
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const byId = new Map(toBackfill.map((x) => [x.id, x]));
    const games: GameCardData[] = rows.map((g) => {
        const bf = byId.get(g.id);
        return ({
        id: g.id,
        provider: g.provider,
        playedAt: g.playedAt.toISOString(),
        timeClass: g.timeClass,
        rated: g.rated,
        result: g.result,
        termination: g.termination,
        whiteName: g.whiteName,
        whiteRating: g.whiteRating,
        blackName: g.blackName,
        blackRating: g.blackRating,
        openingEco: (bf?.eco ?? g.openingEco) ?? null,
        openingName: (bf?.name ?? g.openingName) ?? null,
        openingVariation: (bf?.variation ?? g.openingVariation) ?? null,
        analyzedAt: g.analyzedAt ? g.analyzedAt.toISOString() : null,
        analysis:
            g.analysis && typeof g.analysis === 'object'
                ? ((g.analysis as unknown as Partial<GameAnalysis>) ?? null)
                : null,
        puzzles: puzzlesByGameId.get(g.id) ?? [],
    });
    });

    return (
        <div className="space-y-6">
            <PageHeader
                title="Games"
                subtitle="Browse your analyzed games library."
            />

            <Card>
                <CardContent className="p-4">
                    <SyncGamesWidget context="games" enableAnalyze variant="banner" />
                </CardContent>
            </Card>

            <GamesIndexClient
                games={games}
                total={total}
                page={page}
                totalPages={totalPages}
                baseQueryString={(() => {
                    const p = new URLSearchParams();
                    if (provider) p.set('provider', provider);
                    if (timeClass) p.set('timeClass', timeClass);
                    if (resultParam) p.set('result', resultParam);
                    if (hasAnalysis) p.set('hasAnalysis', hasAnalysis);
                    if (since) p.set('since', since);
                    if (until) p.set('until', until);
                    if (q) p.set('q', q);
                    if (limit !== 20) p.set('limit', String(limit));
                    return p.toString();
                })()}
                userNameByProvider={{
                    lichess: user?.lichessUsername ?? '',
                    chesscom: user?.chesscomUsername ?? '',
                }}
                initialFilters={{
                    provider:
                        provider === 'lichess' || provider === 'chesscom' ? provider : '',
                    timeClass:
                        timeClass === 'bullet' ||
                        timeClass === 'blitz' ||
                        timeClass === 'rapid' ||
                        timeClass === 'classical' ||
                        timeClass === 'unknown'
                            ? timeClass
                            : '',
                    result:
                        resultParam === 'wins' ||
                        resultParam === 'losses' ||
                        resultParam === 'draws'
                            ? (resultParam as 'wins' | 'losses' | 'draws')
                            : '',
                    hasAnalysis:
                        hasAnalysis === 'true' || hasAnalysis === 'false'
                            ? (hasAnalysis as 'true' | 'false')
                            : '',
                    since,
                    until,
                    q,
                }}
            />
        </div>
    );
}


