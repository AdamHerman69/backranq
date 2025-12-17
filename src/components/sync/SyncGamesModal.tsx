'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { NormalizedGame } from '@/lib/types/game';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import {
    fetchGamesFromProvider,
    getExistingExternalIds,
    getSyncStatus,
    saveGamesToLibrary,
    splitNewVsExisting,
    type SyncFilters,
    type SyncProvider,
} from '@/lib/services/gameSync';
import { parseExternalId } from '@/lib/api/games';

type Step = 'config' | 'review' | 'saving' | 'done';

type FetchedRow = {
    game: NormalizedGame;
    provider: SyncProvider;
    externalId: string;
    isNew: boolean;
    selected: boolean;
};

const SYNC_GAMES_MODAL_STORAGE_KEY = 'backrank.syncGamesModal.v1';

function defaultSinceUntilRange(): { since: string; until: string } {
    // Default: last ~30 days, inclusive through end-of-today (UTC).
    const todayStr = new Date().toISOString().slice(0, 10);
    const sinceStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
        since: new Date(sinceStr).toISOString(),
        until: new Date(`${todayStr}T23:59:59.999Z`).toISOString(),
    };
}

export function SyncGamesModal({
    open,
    onClose,
    context = 'games',
    enableAnalyze = true,
    onFinished,
}: {
    open: boolean;
    onClose: () => void;
    context?: 'home' | 'games';
    enableAnalyze?: boolean;
    onFinished?: () => void;
}) {
    const [step, setStep] = useState<Step>('config');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{
        linked: { lichessUsername: string | null; chesscomUsername: string | null };
        lastSync: { lichess: string | null; chesscom: string | null };
    } | null>(null);

    const [providers, setProviders] = useState<{ lichess: boolean; chesscom: boolean }>(
        { lichess: true, chesscom: true }
    );
    const [filters, setFilters] = useState<SyncFilters>({
        timeClass: 'any',
        rated: 'any',
        max: 50,
        since: undefined,
        until: undefined,
    });
    const [analyzeAfter, setAnalyzeAfter] = useState(false);
    const [rows, setRows] = useState<FetchedRow[]>([]);

    useEffect(() => {
        if (!open) return;
        setStep('config');
        setRows([]);
        setAnalyzeAfter(false);
        setBusy(false);

        // Restore last-used date inputs (or default to last month).
        const defaults = defaultSinceUntilRange();
        try {
            const raw = localStorage.getItem(SYNC_GAMES_MODAL_STORAGE_KEY);
            const parsed = raw ? (JSON.parse(raw) as { since?: string; until?: string }) : null;
            setFilters((f) => ({
                ...f,
                since: parsed?.since ?? f.since ?? defaults.since,
                until: parsed?.until ?? f.until ?? defaults.until,
            }));
        } catch {
            setFilters((f) => ({
                ...f,
                since: f.since ?? defaults.since,
                until: f.until ?? defaults.until,
            }));
        }

        getSyncStatus()
            .then((s) => {
                setStatus(s);
                // default providers based on linked usernames
                setProviders({
                    lichess: !!s.linked.lichessUsername,
                    chesscom: !!s.linked.chesscomUsername,
                });
            })
            .catch(() => {});
    }, [open]);

    useEffect(() => {
        if (!open) return;
        // Persist date filters so reopening the modal restores them.
        try {
            localStorage.setItem(
                SYNC_GAMES_MODAL_STORAGE_KEY,
                JSON.stringify({ since: filters.since, until: filters.until })
            );
        } catch {
            // ignore
        }
    }, [open, filters.since, filters.until]);

    const enabledProviders = useMemo(() => {
        const list: SyncProvider[] = [];
        if (providers.lichess) list.push('lichess');
        if (providers.chesscom) list.push('chesscom');
        return list;
    }, [providers]);

    const selectedCount = useMemo(
        () => rows.filter((r) => r.selected && r.isNew).length,
        [rows]
    );
    const newCount = useMemo(() => rows.filter((r) => r.isNew).length, [rows]);
    const dupCount = useMemo(() => rows.filter((r) => !r.isNew).length, [rows]);

    if (!open) return null;

    function close() {
        if (busy) return;
        onClose();
    }

    async function fetchStep() {
        if (!status) {
            toast.error('Missing sync status');
            return;
        }
        if (enabledProviders.length === 0) {
            toast.error('Select at least one provider');
            return;
        }

        // need linked usernames for each provider
        for (const p of enabledProviders) {
            const u = p === 'lichess' ? status.linked.lichessUsername : status.linked.chesscomUsername;
            if (!u) {
                toast.error(`Link your ${p} username in Settings first.`);
                return;
            }
        }

        setBusy(true);
        const toastId = toast.loading('Fetching games…');
        try {
            const fetched: NormalizedGame[] = [];

            for (const p of enabledProviders) {
                const username =
                    p === 'lichess'
                        ? (status.linked.lichessUsername as string)
                        : (status.linked.chesscomUsername as string);
                const games = await fetchGamesFromProvider({
                    provider: p,
                    username,
                    filters,
                });
                fetched.push(...games);
            }

            // group by provider, check existing
            const nextRows: FetchedRow[] = [];
            for (const p of enabledProviders) {
                const providerGames = fetched.filter((g) => g.provider === p);
                const externalIds = providerGames.map((g) => parseExternalId(g));
                const existing = await getExistingExternalIds({
                    provider: p,
                    externalIds,
                });
                const { newGames, existingGames } = splitNewVsExisting(p, providerGames, existing);

                for (const g of newGames) {
                    nextRows.push({
                        game: g,
                        provider: p,
                        externalId: parseExternalId(g),
                        isNew: true,
                        selected: true,
                    });
                }
                for (const g of existingGames) {
                    nextRows.push({
                        game: g,
                        provider: p,
                        externalId: parseExternalId(g),
                        isNew: false,
                        selected: false,
                    });
                }
            }

            // newest first
            nextRows.sort((a, b) => +new Date(b.game.playedAt) - +new Date(a.game.playedAt));
            setRows(nextRows);

            toast.success(`Fetched ${nextRows.length} games`, { id: toastId });
            setStep('review');
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Fetch failed', { id: toastId });
        } finally {
            setBusy(false);
        }
    }

    async function saveStep() {
        const toSave = rows.filter((r) => r.isNew && r.selected).map((r) => r.game);
        if (toSave.length === 0) {
            toast.message('No new games selected');
            return;
        }

        setStep('saving');
        setBusy(true);
        const toastId = toast.loading('Saving games…');
        try {
            const res = await saveGamesToLibrary({ games: toSave });
            toast.success(`Saved ${res.saved} games`, { id: toastId });

            if (enableAnalyze && analyzeAfter) {
                const dbIds = Object.values(res.ids ?? {}).filter(Boolean);
                if (dbIds.length > 0) {
                    backgroundAnalysis.enqueueGameDbIds(dbIds);
                    toast.message('Analysis started in the background.');
                }
            }
            // Update the global bar prompt quickly.
            void backgroundAnalysis.refreshPendingUnanalyzedCount();

            setStep('done');

            onFinished?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Save failed', { id: toastId });
            setStep('review');
        } finally {
            setBusy(false);
        }
    }

    function toggleAllNew(v: boolean) {
        setRows((prev) =>
            prev.map((r) => (r.isNew ? { ...r, selected: v } : r))
        );
    }

    const modalTitle =
        context === 'home' ? 'Sync games to your account' : 'Sync new games';

    return (
        <div
            role="dialog"
            aria-modal="true"
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
                zIndex: 50,
            }}
            onMouseDown={close}
        >
            <div
                style={{
                    width: 'min(980px, 100%)',
                    // shadcn theme vars are HSL triplets; must wrap in hsl(...)
                    background: 'hsl(var(--card, 0 0% 100%))',
                    color: 'hsl(var(--card-foreground, 222.2 84% 4.9%))',
                    borderRadius: 12,
                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                }}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 800 }}>{modalTitle}</div>
                    <button
                        type="button"
                        onClick={close}
                        style={{
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                            background: 'hsl(var(--background, 0 0% 100%))',
                            fontWeight: 700,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            opacity: busy ? 0.5 : 1,
                        }}
                    >
                        Close
                    </button>
                </div>

                {step === 'config' ? (
                    <>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            Choose providers and filters. We’ll only import games not already in your library.
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.lichess}
                                    onChange={(e) => setProviders((p) => ({ ...p, lichess: e.target.checked }))}
                                />
                                <span>Lichess</span>
                            </label>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.chesscom}
                                    onChange={(e) => setProviders((p) => ({ ...p, chesscom: e.target.checked }))}
                                />
                                <span>Chess.com</span>
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Max games</span>
                                <input
                                    inputMode="numeric"
                                    value={String(filters.max)}
                                    onChange={(e) => setFilters((f) => ({ ...f, max: Number(e.target.value) || 50 }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Time class</span>
                                <select
                                    value={filters.timeClass}
                                    onChange={(e) => setFilters((f) => ({ ...f, timeClass: e.target.value as SyncFilters['timeClass'] }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                >
                                    <option value="any">Any</option>
                                    <option value="bullet">Bullet</option>
                                    <option value="blitz">Blitz</option>
                                    <option value="rapid">Rapid</option>
                                    <option value="classical">Classical</option>
                                    <option value="unknown">Unknown</option>
                                </select>
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Rated</span>
                                <select
                                    value={filters.rated}
                                    onChange={(e) => setFilters((f) => ({ ...f, rated: e.target.value as SyncFilters['rated'] }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                >
                                    <option value="any">Any</option>
                                    <option value="rated">Rated only</option>
                                    <option value="casual">Casual only</option>
                                </select>
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Since</span>
                                <input
                                    value={filters.since ? filters.since.slice(0, 10) : ''}
                                    type="date"
                                    onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value ? new Date(e.target.value).toISOString() : undefined }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Until</span>
                                <input
                                    value={filters.until ? filters.until.slice(0, 10) : ''}
                                    type="date"
                                    onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value ? new Date(e.target.value + 'T23:59:59.999Z').toISOString() : undefined }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>
                        </div>

                        {enableAnalyze ? (
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={analyzeAfter}
                                    onChange={(e) => setAnalyzeAfter(e.target.checked)}
                                />
                                <span>Analyze games after import (local Stockfish)</span>
                            </label>
                        ) : null}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={fetchStep}
                                disabled={busy}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor: busy ? 'not-allowed' : 'pointer',
                                    opacity: busy ? 0.7 : 1,
                                }}
                            >
                                Fetch games
                            </button>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                                Last sync: lichess {status?.lastSync.lichess ? new Date(status.lastSync.lichess).toLocaleDateString() : '—'} • chesscom {status?.lastSync.chesscom ? new Date(status.lastSync.chesscom).toLocaleDateString() : '—'}
                            </div>
                        </div>
                    </>
                ) : null}

                {step === 'review' ? (
                    <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12, opacity: 0.85 }}>
                                New: <strong>{newCount}</strong> • Existing: <strong>{dupCount}</strong> • Selected: <strong>{selectedCount}</strong>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    type="button"
                                    onClick={() => toggleAllNew(true)}
                                    style={{
                                        height: 32,
                                        padding: '0 10px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 650,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Select all new
                                </button>
                                <button
                                    type="button"
                                    onClick={() => toggleAllNew(false)}
                                    style={{
                                        height: 32,
                                        padding: '0 10px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 650,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Select none
                                </button>
                            </div>
                        </div>

                        <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', borderRadius: 12 }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                    <tr style={{ textAlign: 'left', opacity: 0.8 }}>
                                        <th style={{ padding: 10 }}></th>
                                        <th style={{ padding: 10 }}>When</th>
                                        <th style={{ padding: 10 }}>Provider</th>
                                        <th style={{ padding: 10 }}>Players</th>
                                        <th style={{ padding: 10 }}>Result</th>
                                        <th style={{ padding: 10 }}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((r) => (
                                        <tr key={`${r.provider}:${r.externalId}`} style={{ borderTop: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))' }}>
                                            <td style={{ padding: 10 }}>
                                                {r.isNew ? (
                                                    <input
                                                        type="checkbox"
                                                        checked={r.selected}
                                                        onChange={(e) =>
                                                            setRows((prev) =>
                                                                prev.map((x) =>
                                                                    x === r ? { ...x, selected: e.target.checked } : x
                                                                )
                                                            )
                                                        }
                                                    />
                                                ) : (
                                                    <span style={{ opacity: 0.5 }}>—</span>
                                                )}
                                            </td>
                                            <td style={{ padding: 10, fontFamily: 'var(--font-geist-mono)' }}>
                                                {new Date(r.game.playedAt).toLocaleString()}
                                            </td>
                                            <td style={{ padding: 10 }}>{r.provider}</td>
                                            <td style={{ padding: 10 }}>
                                                {r.game.white.name} vs {r.game.black.name}
                                            </td>
                                            <td style={{ padding: 10 }}>{r.game.result ?? '—'}</td>
                                            <td style={{ padding: 10 }}>
                                                {r.isNew ? (
                                                    <span style={{ color: '#067647', fontWeight: 750 }}>NEW</span>
                                                ) : (
                                                    <span style={{ opacity: 0.7 }}>Already imported</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                            <button
                                type="button"
                                onClick={saveStep}
                                disabled={busy || selectedCount === 0}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor: busy || selectedCount === 0 ? 'not-allowed' : 'pointer',
                                    opacity: busy || selectedCount === 0 ? 0.6 : 1,
                                }}
                            >
                                Import selected
                            </button>
                            <button
                                type="button"
                                onClick={() => setStep('config')}
                                disabled={busy}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                    background: 'transparent',
                                    fontWeight: 650,
                                    cursor: busy ? 'not-allowed' : 'pointer',
                                    opacity: busy ? 0.6 : 1,
                                }}
                            >
                                Back
                            </button>
                        </div>
                    </>
                ) : null}

                {step === 'saving' ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>Saving…</div>
                ) : null}

                {step === 'done' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ fontWeight: 800 }}>Done</div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            Imported {selectedCount} games{enableAnalyze && analyzeAfter ? '. Analysis is running in the background.' : '.'}
                        </div>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                }}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor: 'pointer',
                                }}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}


