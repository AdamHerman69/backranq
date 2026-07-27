'use client';

import Link from 'next/link';
import { Eye, EyeOff, Loader2, WifiOff } from 'lucide-react';

import type { Puzzle } from '@/lib/analysis/puzzles';
import type { PuzzleAttemptStats } from '@/lib/api/puzzles';
import { uciToSan } from '@/lib/chess/utils';
import type { NormalizedGame } from '@/lib/types/game';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import type { PuzzleAttemptRow } from '@/components/puzzles/puzzleTrainerUtils';

export function PuzzleTrainerDetails({
    currentPuzzle,
    puzzlePly,
    idx,
    loadingNext,
    onPreviousPuzzle,
    onNextPuzzle,
    sourceGame,
    contextHintsEnabled,
    reviewUnlocked,
    openingText,
    sourceLoading,
    sourceError,
    onRetrySource,
    tagsRevealed,
    onToggleTags,
    showPuzzleStats,
    onToggleStats,
    attemptSyncState,
    queuedAttempts,
    attemptOnline,
    attemptSyncError,
    attemptResult,
    onRetrySync,
    puzzleStatsLoading,
    puzzleStatsError,
    puzzleStats,
    isMultiSolutionPuzzle,
    bestMoveSan,
    acceptedMovesText,
    puzzleAttempts,
}: {
    currentPuzzle: Puzzle;
    puzzlePly: number;
    idx: number;
    loadingNext: boolean;
    onPreviousPuzzle: () => void;
    onNextPuzzle: () => void;
    sourceGame: NormalizedGame | null;
    contextHintsEnabled: boolean;
    reviewUnlocked: boolean;
    openingText: string | null | undefined;
    sourceLoading: boolean;
    sourceError: string | null;
    onRetrySource: () => void;
    tagsRevealed: boolean;
    onToggleTags: () => void;
    showPuzzleStats: boolean;
    onToggleStats: () => void;
    attemptSyncState: 'saving' | 'queued' | 'error' | 'saved';
    queuedAttempts: number;
    attemptOnline: boolean;
    attemptSyncError: string | null;
    attemptResult: 'correct' | 'incorrect' | null;
    onRetrySync: () => void;
    puzzleStatsLoading: boolean;
    puzzleStatsError: string | null;
    puzzleStats: PuzzleAttemptStats | null;
    isMultiSolutionPuzzle: boolean;
    bestMoveSan: string;
    acceptedMovesText: string;
    puzzleAttempts: PuzzleAttemptRow[];
}) {
    return (
        <div className="mt-3 space-y-2">
            <div
                className="hidden grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border bg-card p-2 lg:grid"
                aria-label="Puzzle navigation"
            >
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="justify-self-start"
                    onClick={onPreviousPuzzle}
                    disabled={idx <= 0}
                >
                    Previous puzzle
                </Button>
                <span className="text-xs text-muted-foreground">
                    Puzzle {idx + 1}
                </span>
                <Button
                    type="button"
                    size="sm"
                    className="justify-self-end"
                    onClick={onNextPuzzle}
                    disabled={loadingNext}
                >
                    {loadingNext ? 'Loading…' : 'Next puzzle'}
                </Button>
            </div>
            <Link
                href={`/games/${encodeURIComponent(currentPuzzle.sourceGameId)}?ply=${encodeURIComponent(String(puzzlePly))}`}
                className="block rounded-lg border bg-card p-4"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground">
                        {sourceGame?.provider === 'chesscom' ? 'c.com' : 'lich'}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                            {sourceGame
                                ? `${sourceGame.white.name} vs ${sourceGame.black.name}`
                                : 'Source game'}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                            {(contextHintsEnabled || reviewUnlocked) && openingText
                                ? openingText
                                : null}
                            {(contextHintsEnabled || reviewUnlocked) &&
                            openingText &&
                            sourceGame?.playedAt
                                ? ' · '
                                : null}
                            {sourceGame?.playedAt
                                ? new Date(sourceGame.playedAt).toLocaleDateString()
                                : sourceLoading
                                  ? 'Loading source…'
                                  : null}
                        </div>
                    </div>
                </div>
            </Link>
            {sourceError ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    <span>Source details unavailable. The puzzle board still works.</span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRetrySource}
                    >
                        Retry
                    </Button>
                </div>
            ) : null}

            <div className="flex items-center gap-3">
                <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2"
                    onClick={onToggleTags}
                    aria-pressed={tagsRevealed}
                    title={
                        !contextHintsEnabled && !reviewUnlocked
                            ? 'Available after your attempt'
                            : tagsRevealed
                              ? 'Hide tags'
                              : 'Show tags'
                    }
                    disabled={!contextHintsEnabled && !reviewUnlocked}
                >
                    {tagsRevealed ? (
                        <EyeOff className="h-4 w-4" />
                    ) : (
                        <Eye className="h-4 w-4" />
                    )}
                    <span className="ml-2 text-sm">tags</span>
                </Button>

                <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2"
                    onClick={onToggleStats}
                    aria-pressed={showPuzzleStats}
                    title={
                        !reviewUnlocked
                            ? 'Available after your attempt'
                            : showPuzzleStats
                              ? 'Hide puzzle stats'
                              : 'Show puzzle stats'
                    }
                    disabled={!reviewUnlocked}
                >
                    {showPuzzleStats ? (
                        <EyeOff className="h-4 w-4" />
                    ) : (
                        <Eye className="h-4 w-4" />
                    )}
                    <span className="text-sm">stats</span>
                </Button>
            </div>

            <div
                className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
            >
                {attemptSyncState === 'saving' ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving attempt…</>
                ) : queuedAttempts > 0 ? (
                    <>
                        {!attemptOnline ? <WifiOff className="h-3.5 w-3.5" /> : null}
                        {queuedAttempts} attempt{queuedAttempts === 1 ? '' : 's'} queued
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={onRetrySync}
                        >
                            Retry sync
                        </Button>
                    </>
                ) : attemptSyncError ? (
                    <span className="text-amber-700 dark:text-amber-300">{attemptSyncError}</span>
                ) : attemptResult && attemptSyncState === 'saved' ? (
                    <span>Attempt saved</span>
                ) : null}
            </div>

            {tagsRevealed ? (
                <div className="flex flex-wrap gap-1">
                    {(currentPuzzle.tags ?? []).map((tag) => (
                        <Badge key={tag} variant="secondary">
                            {tag}
                        </Badge>
                    ))}
                </div>
            ) : null}

            {showPuzzleStats ? (
                <div className="space-y-3">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Your stats</CardTitle>
                        </CardHeader>
                        <CardContent className="text-sm text-muted-foreground">
                            {puzzleStatsLoading ? (
                                <div>Loading…</div>
                            ) : puzzleStatsError ? (
                                <div className="text-red-600">{puzzleStatsError}</div>
                            ) : puzzleStats ? (
                                <div className="space-y-1">
                                    <div>Attempts: {puzzleStats.attempted}</div>
                                    <div>Correct: {puzzleStats.correct}</div>
                                    <div>
                                        Success rate:{' '}
                                        {puzzleStats.successRate == null
                                            ? '—'
                                            : `${Math.round(puzzleStats.successRate * 100)}%`}
                                    </div>
                                    <div>
                                        Last attempted:{' '}
                                        {puzzleStats.lastAttemptedAt
                                            ? new Date(puzzleStats.lastAttemptedAt).toLocaleString()
                                            : '—'}
                                    </div>
                                    <div>
                                        Avg time:{' '}
                                        {puzzleStats.averageTimeMs == null
                                            ? '—'
                                            : `${Math.round(puzzleStats.averageTimeMs / 1000)}s`}
                                    </div>
                                    <div>
                                        Outcome:{' '}
                                        {puzzleStats.outcome === 'revealed'
                                            ? 'Revealed'
                                            : puzzleStats.outcome === 'skipped'
                                              ? 'Skipped'
                                              : puzzleStats.outcome === 'solved'
                                                ? 'Solved'
                                                : puzzleStats.outcome === 'failed'
                                                  ? 'Failed'
                                                  : 'New'}
                                    </div>
                                </div>
                            ) : (
                                <div>—</div>
                            )}
                        </CardContent>
                    </Card>

                    {isMultiSolutionPuzzle && reviewUnlocked ? (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Solutions</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm text-muted-foreground">
                                <Badge variant="secondary">Multiple correct moves</Badge>
                                <div>
                                    Best move:{' '}
                                    <span className="font-mono text-xs">
                                        {bestMoveSan}
                                    </span>
                                </div>
                                <div>
                                    Accepted moves:{' '}
                                    <span className="font-mono text-xs">{acceptedMovesText}</span>
                                </div>
                            </CardContent>
                        </Card>
                    ) : null}

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">History</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {puzzleStatsLoading ? (
                                <div className="text-sm text-muted-foreground">Loading…</div>
                            ) : puzzleAttempts.length === 0 ? (
                                <div className="text-sm text-muted-foreground">
                                    No attempts yet.
                                </div>
                            ) : (
                                <div className="rounded-md border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Result</TableHead>
                                                <TableHead>Move</TableHead>
                                                <TableHead className="text-right">Time</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {puzzleAttempts.slice(0, 20).map((attempt) => (
                                                <TableRow key={attempt.id}>
                                                    <TableCell>
                                                        <Badge
                                                            className={
                                                                attempt.outcome === 'revealed'
                                                                    ? 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                                                    : attempt.outcome === 'skipped'
                                                                      ? 'border-transparent bg-slate-500/15 text-slate-700 dark:text-slate-300'
                                                                      : attempt.wasCorrect
                                                                        ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                                        : 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300'
                                                            }
                                                        >
                                                            {attempt.outcome === 'revealed'
                                                                ? 'Revealed'
                                                                : attempt.outcome === 'skipped'
                                                                  ? 'Skipped'
                                                                  : attempt.wasCorrect
                                                                    ? 'Correct'
                                                                    : 'Miss'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="font-mono text-xs">
                                                        {attempt.outcome
                                                            ? '—'
                                                            : uciToSan(
                                                                  currentPuzzle.fen,
                                                                  attempt.userMoveUci
                                                              ) ?? attempt.userMoveUci}
                                                    </TableCell>
                                                    <TableCell className="text-right text-sm text-muted-foreground">
                                                        {attempt.timeSpentMs != null
                                                            ? `${Math.round(attempt.timeSpentMs / 1000)}s`
                                                            : '—'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            ) : null}
        </div>
    );
}
