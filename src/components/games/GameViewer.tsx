'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Move as VerboseMove, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { extractStartFenFromPgn, parseUci } from '@/lib/chess/utils';
import {
    getClassificationSymbol,
    type MoveClassification,
    type GameAnalysis,
} from '@/lib/analysis/classification';
import {
    StockfishClient,
    type Score,
} from '@/lib/analysis/stockfishClient';
import { useStockfishLiveMultiPvAnalysis } from '@/lib/hooks/useStockfishLiveMultiPvAnalysis';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

type PuzzlePreview = {
    sourcePly: number;
    type: string;
    bestMoveUci: string;
};

const START_FEN = new Chess().fen();

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

function formatEval(score: Score | null, fen: string): string {
    if (!score) return '—';
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1; // convert to White POV
    if (score.type === 'cp') {
        const v = (score.value / 100) * sign;
        return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
    }
    const mv = score.value * sign;
    return `#${mv}`;
}

function scoreToUnit(score: Score | null, fen: string): number {
    if (!score) return 0.5;
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1; // to White POV

    if (score.type === 'mate') {
        const mv = score.value * sign;
        return mv > 0 ? 1 : 0;
    }
    const cp = score.value * sign;
    const x = cp / 600;
    const t = Math.tanh(x);
    return 0.5 + 0.5 * t;
}

function isEditableTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function classificationAccent(c: MoveClassification): {
    border: string;
    badge: string;
} {
    switch (c) {
        case 'brilliant':
            return {
                border: 'border-l-fuchsia-500/70',
                badge: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
            };
        case 'great':
            return {
                border: 'border-l-emerald-500/70',
                badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            };
        case 'best':
            return {
                border: 'border-l-blue-500/70',
                badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
            };
        case 'excellent':
            return {
                border: 'border-l-green-500/70',
                badge: 'bg-green-500/12 text-green-700 dark:text-green-300',
            };
        case 'good':
            return {
                border: 'border-l-green-500/50',
                badge: 'bg-green-500/10 text-green-700 dark:text-green-300',
            };
        case 'book':
            return {
                border: 'border-l-slate-500/40',
                badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300',
            };
        case 'inaccuracy':
            return {
                border: 'border-l-amber-500/70',
                badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
            };
        case 'mistake':
            return {
                border: 'border-l-orange-500/70',
                badge: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
            };
        case 'blunder':
            return {
                border: 'border-l-red-500/75',
                badge: 'bg-red-500/15 text-red-700 dark:text-red-300',
            };
        default:
            return {
                border: 'border-l-border',
                badge: 'bg-muted text-muted-foreground',
            };
    }
}

export function GameViewer({
    pgn,
    metaLabel,
    analysis,
    puzzles,
}: {
    pgn: string;
    metaLabel?: string;
    analysis?: GameAnalysis | null;
    puzzles?: PuzzlePreview[];
}) {
    const [ply, setPly] = useState(0);
    const [showPvArrows, setShowPvArrows] = useState(true);

    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient] = useState<StockfishClient>(() => {
        const client = new StockfishClient();
        engineRef.current = client;
        return client;
    });
    const [analysisEnabled, setAnalysisEnabled] = useState(true);
    const [analysisMultiPv, setAnalysisMultiPv] = useState(3);
    const [selection, setSelection] = useState<{
        fen: string;
        idx: number;
        key: string | null;
    }>({ fen: START_FEN, idx: 0, key: null });

    const parsed = useMemo(() => {
        const chess = new Chess();
        try {
            chess.loadPgn(pgn, { strict: false });
        } catch {
            return null;
        }
        const verboseMoves = chess.history({ verbose: true }) as VerboseMove[];
        const movesSan = verboseMoves.map((m) => m.san);
        const startFen = (() => {
            const fenTag = extractStartFenFromPgn(pgn);
            if (fenTag) return fenTag;
            const c2 = new Chess();
            try {
                c2.loadPgn(pgn, { strict: false });
                while (c2.undo()) {}
                return c2.fen();
            } catch {
                return START_FEN;
            }
        })();
        // Precompute per-ply positions for fast scrubbing
        const c = new Chess(startFen);
        const positions: { fen: string; lastMove: { from: Square; to: Square } | null }[] =
            [{ fen: c.fen(), lastMove: null }];
        for (const m of verboseMoves) {
            try {
                const mv = c.move({
                    from: m.from,
                    to: m.to,
                    promotion: (m as unknown as { promotion?: string }).promotion,
                });
                if (!mv) break;
                positions.push({
                    fen: c.fen(),
                    lastMove: { from: mv.from as Square, to: mv.to as Square },
                });
            } catch {
                break;
            }
        }
        return { movesSan, verboseMoves, startFen, positions };
    }, [pgn]);

    const clampedPly = useMemo(() => {
        if (!parsed) return 0;
        return clamp(ply, 0, parsed.positions.length - 1);
    }, [ply, parsed]);

    // Keep the active move visible in the move list (keyboard scrubbing).
    useEffect(() => {
        if (!parsed) return;
        if (clampedPly <= 0) return;
        const idx = clampedPly - 1;
        const el = document.getElementById(`game-move-${idx}`);
        el?.scrollIntoView({ block: 'nearest' });
    }, [clampedPly, parsed]);

    const fen = useMemo(() => {
        if (!parsed) return START_FEN;
        return parsed.positions[clampedPly]?.fen ?? parsed.startFen;
    }, [parsed, clampedPly]);

    const lastMove = useMemo(() => {
        if (!parsed) return null;
        return parsed.positions[clampedPly]?.lastMove ?? null;
    }, [parsed, clampedPly]);

    const puzzleByPly = useMemo(() => {
        const m = new Map<number, PuzzlePreview>();
        for (const p of puzzles ?? []) m.set(p.sourcePly, p);
        return m;
    }, [puzzles]);

    // Arrow-key navigation through the game
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            if (!parsed) return;
            // Prevent focused UI (e.g. Radix Tabs) from hijacking arrow keys.
            if (
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight' ||
                e.key === 'Home' ||
                e.key === 'End'
            ) {
                e.stopPropagation();
                // @ts-expect-error - not in lib.dom typings for all TS targets
                e.stopImmediatePropagation?.();
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setPly((p) => Math.max(0, p - 1));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setPly((p) => Math.min(parsed.positions.length - 1, p + 1));
            } else if (e.key === 'Home') {
                e.preventDefault();
                setPly(0);
            } else if (e.key === 'End') {
                e.preventDefault();
                setPly(parsed.positions.length - 1);
            }
        }
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [parsed]);

    const live = useStockfishLiveMultiPvAnalysis({
        client: engineClient,
        fen,
        multiPv: analysisMultiPv,
        enabled: analysisEnabled,
        emitIntervalMs: 150,
        // Run continuously until stopped or position changes.
    });

    const selectedLine = useMemo(() => {
        const lines = live.lines;
        if (selection.fen !== fen) return 0;
        if (selection.key) {
            const idx = lines.findIndex(
                (l) => (l.pvUci ?? []).join(' ') === selection.key
            );
            if (idx >= 0) return idx;
        }
        return Math.max(0, Math.min(selection.idx, lines.length - 1));
    }, [live.lines, selection, fen]);

    useEffect(() => {
        return () => {
            engineRef.current?.terminate();
            engineRef.current = null;
        };
    }, []);

    const analysisEvalScore = useMemo(() => {
        const line = live.lines?.[selectedLine] ?? live.lines?.[0];
        return line?.score ?? null;
    }, [live.lines, selectedLine]);

    const analysisEvalText = useMemo(() => {
        return formatEval(analysisEvalScore, fen);
    }, [analysisEvalScore, fen]);

    const analysisEvalUnit = useMemo(() => {
        return scoreToUnit(analysisEvalScore, fen);
    }, [analysisEvalScore, fen]);

    const analysisArrows = useMemo(() => {
        const byKey = new Map<
            string,
            { startSquare: Square; endSquare: Square; color: string }
        >();
        const put = (a: { startSquare: Square; endSquare: Square; color: string }) => {
            byKey.set(`${a.startSquare}-${a.endSquare}`, a);
        };
        const colors = [
            'rgba(59,130,246,0.80)',
            'rgba(16,185,129,0.75)',
            'rgba(245,158,11,0.75)',
        ];
        const lines = live.lines ?? [];
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            if (i === selectedLine) continue;
            const first = lines[i]?.pvUci?.[0];
            const u = first ? parseUci(first) : null;
            if (!u) continue;
            put({
                startSquare: u.from as Square,
                endSquare: u.to as Square,
                color: colors[i]
                    .replace('0.80', '0.35')
                    .replace('0.75', '0.35'),
            });
        }
        const first = (live.lines ?? [])[selectedLine]?.pvUci?.[0];
        const u = first ? parseUci(first) : null;
        if (u) {
            put({
                startSquare: u.from as Square,
                endSquare: u.to as Square,
                color: colors[selectedLine] ?? 'rgba(59,130,246,0.80)',
            });
        }
        return Array.from(byKey.values());
    }, [live.lines, selectedLine]);

    const squareStyles = useMemo(() => {
        const s: Record<string, React.CSSProperties> = {};
        if (lastMove) {
            s[lastMove.from] = { backgroundColor: 'rgba(255, 215, 0, 0.18)' };
            s[lastMove.to] = { backgroundColor: 'rgba(255, 215, 0, 0.34)' };
        }
        return s;
    }, [lastMove]);

    if (!parsed) {
        return (
            <div className="text-sm text-muted-foreground">
                Unable to parse PGN.
            </div>
        );
    }

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
                <Card>
                    <CardContent className="pt-6">
                        <Chessboard
                            options={{
                                position: fen,
                                allowDragging: false,
                                allowDrawingArrows: false,
                                arrows: showPvArrows ? analysisArrows : [],
                                squareStyles,
                            }}
                        />
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPly(0)}
                                disabled={clampedPly === 0}
                            >
                                Start
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPly((p) => Math.max(0, p - 1))}
                                disabled={clampedPly === 0}
                            >
                                Back
                            </Button>
                            <div className="text-sm text-muted-foreground">
                                Ply {clampedPly} / {parsed.positions.length - 1}
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    setPly((p) =>
                                        Math.min(parsed.positions.length - 1, p + 1)
                                    )
                                }
                                disabled={clampedPly >= parsed.positions.length - 1}
                            >
                                Next
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPly(parsed.positions.length - 1)}
                                disabled={clampedPly >= parsed.positions.length - 1}
                            >
                                End
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="space-y-4">
                <div className="space-y-2">
                    {metaLabel ? (
                        <div className="text-sm text-muted-foreground">
                            {metaLabel}
                        </div>
                    ) : null}
                    {analysis ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                                ♔ {analysis.whiteAccuracy?.toFixed(1) ?? '—'}%
                            </Badge>
                            <Badge variant="outline">
                                ♚ {analysis.blackAccuracy?.toFixed(1) ?? '—'}%
                            </Badge>
                        </div>
                    ) : null}
                </div>

                <Card>
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-2">
                            <CardTitle className="text-base">
                                Analysis (local Stockfish)
                            </CardTitle>
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setAnalysisEnabled((v) => !v)}
                                >
                                    {analysisEnabled ? 'Stop' : 'Start'}
                                </Button>
                                <div className="w-[120px]">
                                    <Select
                                        value={String(analysisMultiPv)}
                                        onValueChange={(v) =>
                                            setAnalysisMultiPv(
                                                Math.max(
                                                    1,
                                                    Math.min(5, Math.trunc(Number(v) || 1))
                                                )
                                            )
                                        }
                                    >
                                        <SelectTrigger className="h-8">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {[1, 2, 3, 4, 5].map((n) => (
                                                <SelectItem key={n} value={String(n)}>
                                                    MultiPV {n}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setShowPvArrows((v) => !v)}
                                >
                                    {showPvArrows ? 'Hide arrows' : 'Show arrows'}
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-sm text-muted-foreground">
                                {analysisEvalText}
                            </div>
                            <div className="h-2 w-40 overflow-hidden rounded-full bg-muted">
                                <div
                                    className="h-2 bg-foreground/70"
                                    style={{
                                        width: `${Math.round(analysisEvalUnit * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>

                        {/* Fixed-height status row to avoid layout shift while scrubbing */}
                        <div className="flex h-5 items-center gap-2">
                            <div
                                className={cn(
                                    'h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/70',
                                    live.running ? 'opacity-100' : 'opacity-0'
                                )}
                                aria-hidden={!live.running}
                            />
                            <div
                                className={cn(
                                    'text-xs text-muted-foreground',
                                    live.running ? 'opacity-100' : 'opacity-0'
                                )}
                            >
                                Thinking…
                                {typeof live.depth === 'number' ? ` d${live.depth}` : ''}
                                {typeof live.timeMs === 'number'
                                    ? ` ${(live.timeMs / 1000).toFixed(1)}s`
                                    : ''}
                            </div>
                            <div className="ml-auto text-xs text-red-600">
                                {live.error ? live.error : null}
                            </div>
                        </div>

                        <div className="space-y-2">
                            {(live.lines ?? []).slice(0, 5).map((l, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => {
                                        setSelection({
                                            fen,
                                            idx: i,
                                            key: (l.pvUci ?? []).join(' '),
                                        });
                                    }}
                                    className={
                                        'w-full rounded-md border px-2 py-1.5 text-left text-sm transition-colors ' +
                                        (i === selectedLine
                                            ? 'bg-muted'
                                            : 'hover:bg-muted/50')
                                    }
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="font-medium">#{i + 1}</div>
                                        <div className="font-mono text-xs text-muted-foreground">
                                            {formatEval(l.score, fen)}
                                            {typeof live.depth === 'number'
                                                ? ` d${live.depth}`
                                                : ''}
                                        </div>
                                    </div>
                                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                        {(l.pvUci ?? []).slice(0, 8).join(' ')}
                                    </div>
                                </button>
                            ))}
                        </div>

                        <Separator />

                        <div className="font-mono text-[11px] text-muted-foreground">
                            PV:{' '}
                            {(live.lines?.[selectedLine]?.pvUci ??
                                live.lines?.[0]?.pvUci ??
                                [])
                                .slice(0, 12)
                                .join(' ')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            Use ←/→ (and Home/End) to navigate the game.
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Moves</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="max-h-[420px] space-y-1 overflow-auto pr-1">
                            {(() => {
                                const rows: { moveNo: number; w?: number; b?: number }[] =
                                    [];
                                for (let i = 0; i < parsed.movesSan.length; i += 2) {
                                    rows.push({
                                        moveNo: i / 2 + 1,
                                        w: i,
                                        b:
                                            i + 1 < parsed.movesSan.length
                                                ? i + 1
                                                : undefined,
                                    });
                                }
                                return rows.map((r) => {
                                    const renderCell = (
                                        idx: number | undefined,
                                        side: 'w' | 'b'
                                    ) => {
                                        if (idx == null)
                                            return <div className="h-8" />;
                                        const san = parsed.movesSan[idx]!;
                                        const analyzedMove = analysis?.moves?.find(
                                            (am) => am.ply === idx
                                        );
                                        const puzzle = puzzleByPly.get(idx);
                                        const symbol = analyzedMove
                                            ? getClassificationSymbol(
                                                  analyzedMove.classification
                                              )
                                            : '';
                                        const hasPuzzle =
                                            !!puzzle || analyzedMove?.hasPuzzle;
                                        const active = clampedPly === idx + 1;
                                        const tooltipParts: string[] = [];
                                        if (analyzedMove) {
                                            tooltipParts.push(
                                                `${analyzedMove.classification}`
                                            );
                                            if (analyzedMove.cpLoss > 0)
                                                tooltipParts.push(
                                                    `-${analyzedMove.cpLoss}cp`
                                                );
                                            if (
                                                analyzedMove.bestMoveSan &&
                                                analyzedMove.san !==
                                                    analyzedMove.bestMoveSan
                                            ) {
                                                tooltipParts.push(
                                                    `Best: ${analyzedMove.bestMoveSan}`
                                                );
                                            }
                                        }
                                        if (puzzle)
                                            tooltipParts.push(
                                                `📋 Puzzle: ${puzzle.type}`
                                            );

                                        const accent = analyzedMove
                                            ? classificationAccent(
                                                  analyzedMove.classification
                                              )
                                            : null;

                                        return (
                                            <Button
                                                key={`${side}-${idx}`}
                                                variant={active ? 'secondary' : 'ghost'}
                                                className={cn(
                                                    'h-8 w-full justify-start gap-2 px-2 py-0 font-mono text-[12px]',
                                                    'border-l-2',
                                                    accent?.border ?? 'border-l-border',
                                                    side === 'w'
                                                        ? 'bg-background'
                                                        : 'bg-muted/30'
                                                    ,
                                                    active && 'ring-1 ring-ring'
                                                )}
                                                id={`game-move-${idx}`}
                                                aria-current={active ? 'true' : undefined}
                                                title={
                                                    tooltipParts.length
                                                        ? tooltipParts.join(' • ')
                                                        : undefined
                                                }
                                                onClick={() => setPly(idx + 1)}
                                            >
                                                <span className="w-9 shrink-0 text-muted-foreground">
                                                    {side === 'w'
                                                        ? `${r.moveNo}.`
                                                        : '…'}
                                                </span>
                                                <span className="truncate">{san}</span>
                                                {symbol ? (
                                                    <span
                                                        className={cn(
                                                            'ml-auto rounded px-1 py-0.5 text-[10px] font-semibold',
                                                            accent?.badge ??
                                                                'bg-muted text-muted-foreground'
                                                        )}
                                                    >
                                                        {symbol}
                                                    </span>
                                                ) : (
                                                    <span className="ml-auto" />
                                                )}
                                                {hasPuzzle ? (
                                                    <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-violet-500/80" />
                                                ) : null}
                                            </Button>
                                        );
                                    };

                                    return (
                                        <div
                                            key={r.moveNo}
                                            className="grid grid-cols-2 gap-1"
                                        >
                                            {renderCell(r.w, 'w')}
                                            {renderCell(r.b, 'b')}
                                        </div>
                                    );
                                });
                            })()}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}


