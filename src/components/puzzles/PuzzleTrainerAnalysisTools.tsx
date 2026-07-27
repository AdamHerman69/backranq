'use client';

import { Loader2 } from 'lucide-react';

import type { Score } from '@/lib/analysis/stockfishClient';
import { uciLineToSan } from '@/lib/chess/utils';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { formatEval } from '@/components/puzzles/puzzleTrainerUtils';

type AnalysisLine = {
    score: Score | null;
    pvUci?: string[];
};

export function PuzzleTrainerAnalysisTools({
    error,
    analysisEnabled,
    engineReady,
    currentAnalysis,
    analysisMultiPv,
    selectedLine,
    depth,
    fallbackFen,
    onSelectLine,
    onMultiPvChange,
    onToggleEngine,
    canToggleEngine,
}: {
    error: string | null;
    analysisEnabled: boolean;
    engineReady: boolean;
    currentAnalysis: { fen: string; lines: AnalysisLine[] } | null;
    analysisMultiPv: number;
    selectedLine: number;
    depth: number | null;
    fallbackFen: string;
    onSelectLine: (index: number, key: string) => void;
    onMultiPvChange: (value: number) => void;
    onToggleEngine: () => void;
    canToggleEngine: boolean;
}) {
    return (
        <div className="mt-3 space-y-2">
            <div
                className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                aria-label="Board arrow legend"
            >
                <span className="font-medium text-foreground">Arrows</span>
                <span><span aria-hidden="true" className="mr-1 text-blue-500">●</span>Line 1</span>
                <span><span aria-hidden="true" className="mr-1 text-emerald-500">●</span>Line 2</span>
                <span><span aria-hidden="true" className="mr-1 text-amber-500">●</span>Line 3</span>
                <span>Shown only at the analyzed root position.</span>
            </div>
            {error ? (
                <div
                    className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300"
                    role="alert"
                >
                    {error}
                </div>
            ) : analysisEnabled &&
              engineReady &&
              (currentAnalysis?.lines.length ?? 0) === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Engine is calculating candidate lines…
                </div>
            ) : null}
            <div className="space-y-2">
                {(currentAnalysis?.lines ?? [])
                    .slice(0, Math.max(1, Math.min(5, analysisMultiPv)))
                    .map((line, index) => (
                        <button
                            key={index}
                            type="button"
                            onClick={() =>
                                onSelectLine(index, (line.pvUci ?? []).join(' '))
                            }
                            className={
                                'w-full rounded-md border bg-card px-3 py-3 text-left text-sm transition-colors ' +
                                (index === selectedLine
                                    ? 'bg-muted'
                                    : 'hover:bg-muted/50')
                            }
                        >
                            <div className="flex items-center justify-between gap-2">
                                <div className="font-medium">#{index + 1}</div>
                                <div className="font-mono text-xs text-muted-foreground">
                                    {formatEval(
                                        line.score,
                                        currentAnalysis?.fen ?? fallbackFen
                                    )}
                                    {typeof depth === 'number' ? ` d${depth}` : ''}
                                </div>
                            </div>
                            <div className="mt-1 font-mono text-xs text-muted-foreground">
                                {uciLineToSan(
                                    currentAnalysis?.fen ?? fallbackFen,
                                    line.pvUci ?? [],
                                    6
                                ).join(' ')}
                            </div>
                        </button>
                    ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="w-[140px]">
                    <Select
                        value={String(analysisMultiPv)}
                        onValueChange={(value) =>
                            onMultiPvChange(
                                Math.max(
                                    1,
                                    Math.min(5, Math.trunc(Number(value) || 1))
                                )
                            )
                        }
                    >
                        <SelectTrigger className="h-9">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {[1, 2, 3, 4, 5].map((count) => (
                                <SelectItem key={count} value={String(count)}>
                                    Lines {count}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <Button
                    type="button"
                    variant="outline"
                    className="h-9"
                    onClick={onToggleEngine}
                    disabled={!canToggleEngine}
                >
                    {analysisEnabled ? 'Pause engine' : 'Resume engine'}
                </Button>
            </div>
        </div>
    );
}
