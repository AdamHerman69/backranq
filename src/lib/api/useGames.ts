import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnalyzedGame } from '@prisma/client';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';

export type GamesQuery = {
    page?: number;
    limit?: number;
    provider?: 'lichess' | 'chesscom';
    timeClass?: 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
    result?: string;
    since?: string; // ISO
    until?: string; // ISO
    hasAnalysis?: boolean;
};

export function useGames(query: GamesQuery) {
    const [data, setData] = useState<{
        games: Partial<AnalyzedGame>[];
        total: number;
        page: number;
        totalPages: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const qs = useMemo(() => {
        const p = new URLSearchParams();
        if (query.page) p.set('page', String(query.page));
        if (query.limit) p.set('limit', String(query.limit));
        if (query.provider) p.set('provider', query.provider);
        if (query.timeClass) p.set('timeClass', query.timeClass);
        if (query.result) p.set('result', query.result);
        if (query.since) p.set('since', query.since);
        if (query.until) p.set('until', query.until);
        if (typeof query.hasAnalysis === 'boolean')
            p.set('hasAnalysis', query.hasAnalysis ? 'true' : 'false');
        return p.toString();
    }, [query]);

    const refetch = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/games${qs ? `?${qs}` : ''}`, {
                cache: 'no-store',
            });
            const json = (await res.json().catch(() => ({}))) as any;
            if (!res.ok) {
                throw new Error(json?.error ?? 'Failed to load games');
            }
            setData(json);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load games');
        } finally {
            setLoading(false);
        }
    }, [qs]);

    useEffect(() => {
        void refetch();
    }, [refetch]);

    return { data, error, loading, refetch };
}

export function useSaveGames() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = useCallback(
        async (args: {
            games: NormalizedGame[];
            analyses?: Record<string, GameAnalysis>;
        }) => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch('/api/games', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(args),
                });
                const json = (await res.json().catch(() => ({}))) as any;
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to save games');
                return json as { saved: number; skipped: number };
            } catch (e) {
                const msg =
                    e instanceof Error ? e.message : 'Failed to save games';
                setError(msg);
                throw new Error(msg);
            } finally {
                setLoading(false);
            }
        },
        []
    );

    return { save, loading, error };
}

export function useGameAnalysis(gameId: string | null) {
    const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchGame = useCallback(async () => {
        if (!gameId) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/games/${encodeURIComponent(gameId)}`,
                {
                    cache: 'no-store',
                }
            );
            const json = (await res.json().catch(() => ({}))) as any;
            if (!res.ok) throw new Error(json?.error ?? 'Failed to load game');
            setAnalysis((json?.game?.analysis ?? null) as GameAnalysis | null);
        } catch (e) {
            setError(
                e instanceof Error ? e.message : 'Failed to load analysis'
            );
        } finally {
            setLoading(false);
        }
    }, [gameId]);

    const save = useCallback(
        async (next: GameAnalysis) => {
            if (!gameId) throw new Error('Missing gameId');
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(
                    `/api/games/${encodeURIComponent(gameId)}/analysis`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(next),
                    }
                );
                const json = (await res.json().catch(() => ({}))) as any;
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to save analysis');
                setAnalysis(next);
                return json as { ok: true };
            } catch (e) {
                const msg =
                    e instanceof Error ? e.message : 'Failed to save analysis';
                setError(msg);
                throw new Error(msg);
            } finally {
                setLoading(false);
            }
        },
        [gameId]
    );

    useEffect(() => {
        void fetchGame();
    }, [fetchGame]);

    return { analysis, loading, error, refetch: fetchGame, save };
}

