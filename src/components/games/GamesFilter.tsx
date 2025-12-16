'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

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

    useEffect(() => {
        setFilters(initial);
    }, [initial]);

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
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{total} games</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Provider</span>
                    <select
                        value={filters.provider}
                        onChange={(e) => {
                            const next = { ...filters, provider: e.target.value as GamesFilters['provider'] };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    >
                        <option value="">All</option>
                        <option value="lichess">Lichess</option>
                        <option value="chesscom">Chess.com</option>
                    </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Time class</span>
                    <select
                        value={filters.timeClass}
                        onChange={(e) => {
                            const next = { ...filters, timeClass: e.target.value as GamesFilters['timeClass'] };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    >
                        <option value="">All</option>
                        <option value="bullet">Bullet</option>
                        <option value="blitz">Blitz</option>
                        <option value="rapid">Rapid</option>
                        <option value="classical">Classical</option>
                        <option value="unknown">Unknown</option>
                    </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Result</span>
                    <select
                        value={filters.result}
                        onChange={(e) => {
                            const next = { ...filters, result: e.target.value as GamesFilters['result'] };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    >
                        <option value="">All</option>
                        <option value="wins">Wins</option>
                        <option value="losses">Losses</option>
                        <option value="draws">Draws</option>
                    </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Since</span>
                    <input
                        type="date"
                        value={filters.since}
                        onChange={(e) => {
                            const next = { ...filters, since: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Until</span>
                    <input
                        type="date"
                        value={filters.until}
                        onChange={(e) => {
                            const next = { ...filters, until: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75 }}>
                    <span>Analysis</span>
                    <select
                        value={filters.hasAnalysis}
                        onChange={(e) => {
                            const next = { ...filters, hasAnalysis: e.target.value as GamesFilters['hasAnalysis'] };
                            setFilters(next);
                            push(next);
                        }}
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    >
                        <option value="">All</option>
                        <option value="true">Analyzed</option>
                        <option value="false">Not analyzed</option>
                    </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.75, gridColumn: '1 / -1' }}>
                    <span>Search opponent</span>
                    <input
                        value={filters.q}
                        onChange={(e) => {
                            const next = { ...filters, q: e.target.value };
                            setFilters(next);
                            push(next);
                        }}
                        placeholder="Opponent name…"
                        style={{ height: 36, borderRadius: 10, border: '1px solid var(--border, #e6e6e6)', padding: '0 10px' }}
                    />
                </label>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                    type="button"
                    onClick={clear}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid var(--border, #e6e6e6)',
                        background: 'transparent',
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >
                    Clear filters
                </button>
            </div>
        </section>
    );
}


