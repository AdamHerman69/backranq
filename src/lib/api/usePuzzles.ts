'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Puzzle } from '@/lib/analysis/puzzles';
import type { PuzzleAttemptStats } from '@/lib/api/puzzles';

type ApiError = { error?: string };
type PuzzlesListResponse = ApiError & {
    puzzles?: PuzzleWithStats[];
    total?: number;
    page?: number;
    totalPages?: number;
};
type PuzzleResponse = ApiError & {
    puzzle?: PuzzleWithStats | null;
    attempts?: {
        id: string;
        attemptedAt: string;
        userMoveUci: string;
        wasCorrect: boolean;
        timeSpentMs: number | null;
    }[];
};
type RandomPuzzlesResponse = ApiError & { puzzles?: PuzzleWithStats[] };

export type PuzzlesListFilters = {
    page?: number;
    limit?: number;
    type?: '' | 'avoidBlunder' | 'punishBlunder';
    kind?: '' | 'blunder' | 'missedWin' | 'missedTactic';
    phase?: '' | 'opening' | 'middlegame' | 'endgame';
    gameId?: string;
    opening?: string;
    tags?: string[];
    solved?: boolean;
    failed?: boolean;
};

export type PuzzleWithStats = Puzzle & { attemptStats?: PuzzleAttemptStats };

export function usePuzzles(filters: PuzzlesListFilters) {
    const [puzzles, setPuzzles] = useState<PuzzleWithStats[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(filters.page ?? 1);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const qs = useMemo(() => {
        const p = new URLSearchParams();
        if (filters.page) p.set('page', String(filters.page));
        if (filters.limit) p.set('limit', String(filters.limit));
        if (filters.type) p.set('type', filters.type);
        if (filters.kind) p.set('kind', filters.kind);
        if (filters.phase) p.set('phase', filters.phase);
        if (filters.gameId) p.set('gameId', filters.gameId);
        if (filters.opening) p.set('opening', filters.opening);
        if (filters.tags && filters.tags.length > 0)
            p.set('tags', filters.tags.join(','));
        if (typeof filters.solved === 'boolean')
            p.set('solved', String(filters.solved));
        if (typeof filters.failed === 'boolean')
            p.set('failed', String(filters.failed));
        return p.toString();
    }, [filters]);

    const fetchList = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/puzzles?${qs}`);
            const raw = (await res.json().catch(() => ({}))) as unknown;
            const json: PuzzlesListResponse =
                raw && typeof raw === 'object'
                    ? (raw as PuzzlesListResponse)
                    : {};
            if (!res.ok)
                throw new Error(json?.error ?? 'Failed to load puzzles');
            setPuzzles(Array.isArray(json?.puzzles) ? json.puzzles : []);
            setTotal(typeof json?.total === 'number' ? json.total : 0);
            setPage(
                typeof json?.page === 'number' ? json.page : filters.page ?? 1
            );
            setTotalPages(
                typeof json?.totalPages === 'number' ? json.totalPages : 1
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load puzzles');
        } finally {
            setLoading(false);
        }
    }, [qs, filters.page]);

    useEffect(() => {
        fetchList();
    }, [fetchList]);

    return {
        puzzles,
        total,
        page,
        totalPages,
        loading,
        error,
        refetch: fetchList,
    };
}

export function usePuzzle(id: string | null) {
    const [puzzle, setPuzzle] = useState<PuzzleWithStats | null>(null);
    const [attempts, setAttempts] = useState<
        {
            id: string;
            attemptedAt: string;
            userMoveUci: string;
            wasCorrect: boolean;
            timeSpentMs: number | null;
        }[]
    >([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchOne = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/puzzles/${id}`);
            const raw = (await res.json().catch(() => ({}))) as unknown;
            const json: PuzzleResponse =
                raw && typeof raw === 'object' ? (raw as PuzzleResponse) : {};
            if (!res.ok)
                throw new Error(json?.error ?? 'Failed to load puzzle');
            setPuzzle(json?.puzzle ?? null);
            setAttempts(Array.isArray(json?.attempts) ? json.attempts : []);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load puzzle');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        fetchOne();
    }, [fetchOne]);

    return { puzzle, attempts, loading, error, refetch: fetchOne };
}

export function useRandomPuzzles() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const getRandom = useCallback(
        async (args: {
            count?: number;
            type?: '' | 'avoidBlunder' | 'punishBlunder';
            kind?: '' | 'blunder' | 'missedWin' | 'missedTactic';
            phase?: '' | 'opening' | 'middlegame' | 'endgame';
            multiSolution?: '' | 'any' | 'single' | 'multi';
            openingEco?: string[];
            tags?: string[];
            solved?: boolean;
            failed?: boolean;
            gameId?: string;
            excludeIds?: string[];
            preferFailed?: boolean;
        }) => {
            setLoading(true);
            setError(null);
            try {
                const p = new URLSearchParams();
                if (args.count) p.set('count', String(args.count));
                if (args.type) p.set('type', args.type);
                if (args.kind) p.set('kind', args.kind);
                if (args.phase) p.set('phase', args.phase);
                if (args.multiSolution && args.multiSolution !== 'any')
                    p.set('multiSolution', args.multiSolution);
                if (args.openingEco && args.openingEco.length > 0)
                    p.set('openingEco', args.openingEco.join(','));
                if (args.tags && args.tags.length > 0)
                    p.set('tags', args.tags.join(','));
                if (typeof args.solved === 'boolean')
                    p.set('solved', String(args.solved));
                if (typeof args.failed === 'boolean')
                    p.set('failed', String(args.failed));
                if (args.gameId) p.set('gameId', args.gameId);
                if (args.excludeIds && args.excludeIds.length > 0)
                    p.set('excludeIds', args.excludeIds.join(','));
                if (args.preferFailed) p.set('preferFailed', 'true');
                const res = await fetch(`/api/puzzles/random?${p.toString()}`);
                const raw = (await res.json().catch(() => ({}))) as unknown;
                const json: RandomPuzzlesResponse =
                    raw && typeof raw === 'object'
                        ? (raw as RandomPuzzlesResponse)
                        : {};
                if (!res.ok)
                    throw new Error(
                        json?.error ?? 'Failed to load random puzzles'
                    );
                return (
                    Array.isArray(json?.puzzles) ? json.puzzles : []
                ) as PuzzleWithStats[];
            } catch (e) {
                setError(
                    e instanceof Error
                        ? e.message
                        : 'Failed to load random puzzles'
                );
                return [];
            } finally {
                setLoading(false);
            }
        },
        []
    );

    return { getRandom, loading, error };
}

export function useRecordAttempt() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const record = useCallback(
        async (args: {
            puzzleId: string;
            userMoveUci: string;
            wasCorrect: boolean;
            timeSpentMs?: number;
        }) => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(
                    `/api/puzzles/${args.puzzleId}/attempt`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userMoveUci: args.userMoveUci,
                            wasCorrect: args.wasCorrect,
                            timeSpentMs: args.timeSpentMs,
                        }),
                    }
                );
                const json = (await res.json().catch(() => ({}))) as
                    | ({
                          ok?: true;
                          attemptStats?: PuzzleAttemptStats;
                      } & ApiError)
                    | ApiError;
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to record attempt');
                if (
                    json &&
                    typeof json === 'object' &&
                    'ok' in json &&
                    (json as { ok?: unknown }).ok === true &&
                    'attemptStats' in json &&
                    (json as { attemptStats?: unknown }).attemptStats
                ) {
                    return json as {
                        ok: true;
                        attemptStats: PuzzleAttemptStats;
                    };
                }
                return null;
            } catch (e) {
                setError(
                    e instanceof Error ? e.message : 'Failed to record attempt'
                );
                return null;
            } finally {
                setLoading(false);
            }
        },
        []
    );

    return { record, loading, error };
}

export function usePuzzleStats() {
    const [stats, setStats] = useState<unknown>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchStats = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/puzzles/stats');
            const json = (await res.json().catch(() => ({}))) as
                | (Record<string, unknown> & ApiError)
                | ApiError;
            if (!res.ok) throw new Error(json?.error ?? 'Failed to load stats');
            setStats(json);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load stats');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    return { stats, loading, error, refetch: fetchStats };
}
