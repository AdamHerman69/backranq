import { redirect } from 'next/navigation';
import styles from './page.module.css';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { AppNav } from '@/components/nav/AppNav';
import { GamesFilter } from '@/components/games/GamesFilter';
import { GamesList } from '@/components/games/GamesList';
import type { GameCardData } from '@/components/games/GameCard';
import { SyncGamesWidget } from '@/components/sync/SyncGamesWidget';
import type { Prisma } from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';

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
                openingEco: true,
                openingName: true,
                analyzedAt: true,
                analysis: true,
            },
        }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const games: GameCardData[] = rows.map((g) => ({
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
        openingEco: g.openingEco,
        openingName: g.openingName,
        analyzedAt: g.analyzedAt ? g.analyzedAt.toISOString() : null,
        analysis:
            g.analysis && typeof g.analysis === 'object'
                ? ((g.analysis as unknown as Partial<GameAnalysis>) ?? null)
                : null,
    }));

    return (
        <div className={styles.page}>
            <main className={styles.main}>
                <AppNav />
                <header className={styles.header}>
                    <h1>Games</h1>
                    <p>Browse your analyzed games library.</p>
                </header>

                <section className={styles.panel}>
                    <SyncGamesWidget context="games" enableAnalyze variant="banner" />
                </section>

                <section className={styles.panel}>
                    <GamesFilter
                        total={total}
                        initial={{
                            provider:
                                provider === 'lichess' || provider === 'chesscom'
                                    ? provider
                                    : '',
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
                </section>

                <GamesList
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
                />
            </main>
        </div>
    );
}


