'use client';

import { Filter } from 'lucide-react';

import type { Puzzle } from '@/lib/analysis/puzzles';
import type { PuzzleNonMoveOutcome } from '@/lib/puzzles/attemptOutcomes';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TrainerViewMode = 'solve' | 'analyze';

export function PuzzleTrainerHeader({
    viewMode,
    onViewModeChange,
    filtersOpen,
    onToggleFilters,
    filtersSummary,
    uiFilters,
    currentPuzzle,
    sideToMoveLabel,
    contextHintsEnabled,
    reviewUnlocked,
    preferencesLoading,
    localOutcome,
    analysisTrackLabel,
    engineStatus,
    evalUnit,
    evalText,
}: {
    viewMode: TrainerViewMode;
    onViewModeChange: (mode: TrainerViewMode) => void;
    filtersOpen: boolean;
    onToggleFilters: () => void;
    filtersSummary: string;
    uiFilters: PuzzlesFilters;
    currentPuzzle: Puzzle | null;
    sideToMoveLabel: string;
    contextHintsEnabled: boolean;
    reviewUnlocked: boolean;
    preferencesLoading: boolean;
    localOutcome: PuzzleNonMoveOutcome | 'solved' | 'failed' | null;
    analysisTrackLabel: string;
    engineStatus: string;
    evalUnit: number;
    evalText: string;
}) {
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Tabs
                    value={viewMode}
                    className="flex-1"
                    onValueChange={(value) => {
                        if (value === 'solve' || value === 'analyze') {
                            onViewModeChange(value);
                        }
                    }}
                >
                    <TabsList className="w-full">
                        <TabsTrigger className="flex-1" value="solve">
                            Solve
                        </TabsTrigger>
                        <TabsTrigger className="flex-1" value="analyze">
                            Analyze
                        </TabsTrigger>
                    </TabsList>
                </Tabs>

                <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0 gap-2 px-3"
                    onClick={onToggleFilters}
                    aria-expanded={filtersOpen}
                    aria-label="Filters"
                    title="Filters"
                >
                    <Filter className="h-4 w-4" />
                    <span className="max-w-[10rem] truncate text-xs text-muted-foreground">
                        {filtersSummary}
                    </span>
                </Button>
            </div>

            {filtersOpen ? (
                <div className="w-full rounded-lg border bg-card p-3">
                    <PuzzlesFilter
                        initial={uiFilters}
                        preserveKeys={['view']}
                        autoApply={false}
                    />
                </div>
            ) : null}

            {currentPuzzle ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
                    <p className="text-sm font-medium">
                        {sideToMoveLabel} to move — find the best move
                    </p>
                    {contextHintsEnabled || reviewUnlocked ? (
                        <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary">
                                {currentPuzzle.mode === 'punishBlunder'
                                    ? 'Punish a mistake'
                                    : 'Avoid a mistake'}
                            </Badge>
                            {currentPuzzle.type ? (
                                <Badge variant="outline">{currentPuzzle.type}</Badge>
                            ) : null}
                        </div>
                    ) : preferencesLoading ? (
                        <span className="text-xs text-muted-foreground">
                            Loading preferences…
                        </span>
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            Spoiler-free
                        </span>
                    )}
                    {localOutcome === 'revealed' || localOutcome === 'skipped' ? (
                        <Badge
                            variant="outline"
                            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                        >
                            {localOutcome === 'revealed' ? 'Revealed' : 'Skipped'}
                        </Badge>
                    ) : null}
                </div>
            ) : null}

            {viewMode === 'analyze' ? (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                            Track:{' '}
                            <strong className="font-medium text-foreground">
                                {analysisTrackLabel}
                            </strong>
                        </span>
                        <span role="status">{engineStatus}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-full flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-2 bg-foreground/70"
                                style={{ width: `${Math.round(evalUnit * 100)}%` }}
                            />
                        </div>
                        <div className="min-w-[3.5rem] text-right font-mono text-sm text-muted-foreground">
                            {evalText}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
