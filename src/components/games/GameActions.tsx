'use client';

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { extractPuzzlesFromGames } from '@/lib/analysis/extractPuzzles';
import { AnalysisProgress, type AnalysisProgressState } from '@/components/analysis/AnalysisProgress';

export function GameActions({
    dbGameId,
    normalizedGame,
    usernameByProvider,
    hasAnalysis,
    onAnalysisSaved,
}: {
    dbGameId: string;
    normalizedGame: NormalizedGame;
    usernameByProvider: { lichess?: string; chesscom?: string };
    hasAnalysis: boolean;
    onAnalysisSaved?: (analysis: GameAnalysis) => void;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<AnalysisProgressState | null>(null);
    const engineRef = useRef<StockfishClient | null>(null);

    const providerKey = normalizedGame.provider;
    const linkedUserName =
        providerKey === 'lichess'
            ? usernameByProvider.lichess
            : usernameByProvider.chesscom;

    const canAnalyze = useMemo(() => {
        return !!linkedUserName?.trim();
    }, [linkedUserName]);

    function cancel() {
        engineRef.current?.cancelAll();
        engineRef.current?.terminate();
        engineRef.current = null;
        setBusy(false);
        setProgress(null);
        toast.message('Cancelled analysis');
    }

    async function analyze(mode: 'analyze' | 'reanalyze') {
        if (!canAnalyze) {
            toast.error(
                `To analyze, first link your ${normalizedGame.provider} username in Settings.`
            );
            return;
        }

        setBusy(true);
        const id = toast.loading(
            mode === 'reanalyze' ? 'Re-analyzing game…' : 'Analyzing game…'
        );
        try {
            const engine = engineRef.current ?? new StockfishClient();
            engineRef.current = engine;

            const res = await extractPuzzlesFromGames({
                games: [normalizedGame],
                selectedGameIds: new Set([normalizedGame.id]),
                engine,
                usernameByProvider,
                onProgress: (p) => {
                    const percent =
                        p.plyCount > 0 ? ((p.ply + 1) / p.plyCount) * 100 : 0;
                    setProgress({
                        label: `Ply ${p.ply + 1}/${p.plyCount}`,
                        percent,
                        phase: p.phase,
                    });
                },
                options: {
                    movetimeMs: 200,
                    returnAnalysis: true,
                    // Generate puzzles too (unlimited for analyzed games).
                    maxPuzzlesPerGame: null,
                    puzzleMode: 'both',
                },
            });

            const analysis = res.analysis?.get(normalizedGame.id);
            if (!analysis) throw new Error('Analysis produced no result');

            const saveRes = await fetch(`/api/games/${dbGameId}/analysis`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(analysis),
            });
            const saveJson = (await saveRes.json().catch(() => ({}))) as {
                error?: string;
            };
            if (!saveRes.ok) throw new Error(saveJson.error ?? 'Failed to save');

            const puzzlesForGame = (res.puzzles ?? []).filter(
                (p) => p.sourceGameId === normalizedGame.id
            );
            const puzzlesRes = await fetch(`/api/games/${dbGameId}/puzzles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ puzzles: puzzlesForGame }),
            });
            const puzzlesJson = (await puzzlesRes.json().catch(() => ({}))) as {
                error?: string;
                created?: number;
            };
            if (!puzzlesRes.ok)
                throw new Error(puzzlesJson.error ?? 'Failed to save puzzles');

            toast.success('Analysis saved', { id });
            onAnalysisSaved?.(analysis);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Analysis failed', { id });
        } finally {
            setBusy(false);
            setProgress(null);
        }
    }

    async function exportPgn() {
        try {
            const blob = new Blob([normalizedGame.pgn], {
                type: 'application/x-chess-pgn',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${normalizedGame.provider}-${normalizedGame.id}.pgn`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            toast.error('Failed to export PGN');
        }
    }

    async function deleteGame() {
        const ok = window.confirm('Delete this game? This cannot be undone.');
        if (!ok) return;
        const id = toast.loading('Deleting game…');
        try {
            const res = await fetch(`/api/games/${dbGameId}`, { method: 'DELETE' });
            const json = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(json.error ?? 'Delete failed');
            toast.success('Game deleted', { id });
            router.push('/games');
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Delete failed', { id });
        }
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {progress ? <AnalysisProgress state={progress} onCancel={cancel} /> : null}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {!hasAnalysis ? (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => analyze('analyze')}
                        style={{
                            height: 36,
                            padding: '0 12px',
                            borderRadius: 10,
                            border: '1px solid transparent',
                            background: 'var(--text-primary, #000)',
                            color: 'var(--background, #fafafa)',
                            fontWeight: 650,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            opacity: busy ? 0.7 : 1,
                        }}
                    >
                        Analyze game
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => analyze('reanalyze')}
                        style={{
                            height: 36,
                            padding: '0 12px',
                            borderRadius: 10,
                            border: '1px solid var(--border, #e6e6e6)',
                            background: 'transparent',
                            fontWeight: 650,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            opacity: busy ? 0.7 : 1,
                        }}
                    >
                        Re-analyze
                    </button>
                )}

                <Link
                    href="/"
                    style={{ fontWeight: 650, textDecoration: 'underline' }}
                    title="Puzzle generation runs automatically on analysis"
                >
                    Generate puzzles →
                </Link>

                <button
                    type="button"
                    onClick={exportPgn}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid var(--border, #e6e6e6)',
                        background: 'transparent',
                        fontWeight: 650,
                        cursor: 'pointer',
                    }}
                >
                    Export PGN
                </button>

                <button
                    type="button"
                    onClick={deleteGame}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid rgba(180,35,24,0.35)',
                        background: 'rgba(180,35,24,0.08)',
                        color: '#b42318',
                        fontWeight: 750,
                        cursor: 'pointer',
                    }}
                >
                    Delete
                </button>
            </div>

            {!canAnalyze ? (
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Link your {normalizedGame.provider} username in{' '}
                    <Link href="/settings">Settings</Link> to enable analysis.
                </div>
            ) : null}
        </div>
    );
}


