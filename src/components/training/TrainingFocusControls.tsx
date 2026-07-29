'use client';

import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type {
    TrainingPhase,
    TrainingSessionFilters,
    TrainingSessionFocus,
} from '@/lib/training/api';

type SourceFocus = 'SAVED' | 'ALL' | 'MY_MISTAKES' | 'MISSED_CHANCES';
type PhaseFocus = 'ALL' | TrainingPhase;
type HistoryFocus = 'ALL' | 'FRESH';

export function filtersForTrainingFocus({
    source,
    impact,
    phase,
    history,
}: {
    source: SourceFocus;
    impact: TrainingSessionFocus;
    phase: PhaseFocus;
    history: HistoryFocus;
}): TrainingSessionFilters {
    return {
        focus: impact,
        ...(source === 'ALL'
            ? {
                  sourceKinds: [
                      'MY_MISTAKE',
                      'MISSED_OPPORTUNITY',
                  ] as const,
              }
            : source === 'MY_MISTAKES'
              ? { sourceKinds: ['MY_MISTAKE'] as const }
              : source === 'MISSED_CHANCES'
                ? {
                      sourceKinds: ['MISSED_OPPORTUNITY'] as const,
                  }
                : {}),
        ...(phase === 'ALL' ? {} : { phases: [phase] }),
        ...(history === 'FRESH' ? { includeAttempted: false } : {}),
    };
}

export function TrainingFocusControls({
    disabled,
    onApply,
}: {
    disabled: boolean;
    onApply: (filters: TrainingSessionFilters) => void;
}) {
    const [source, setSource] = useState<SourceFocus>('SAVED');
    const [impact, setImpact] = useState<TrainingSessionFocus>('ALL');
    const [phase, setPhase] = useState<PhaseFocus>('ALL');
    const [history, setHistory] = useState<HistoryFocus>('ALL');

    const filters = useMemo(
        () =>
            filtersForTrainingFocus({
                source,
                impact,
                phase,
                history,
            }),
        [history, impact, phase, source]
    );

    return (
        <div
            className="rounded-xl border bg-card p-4"
            aria-label="Session focus"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2 font-medium">
                        <SlidersHorizontal
                            className="h-4 w-4"
                            aria-hidden="true"
                        />
                        Session focus
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Choose what to practise now. Every extracted moment
                        stays in your library.
                    </p>
                </div>
                <Button
                    type="button"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onApply(filters)}
                >
                    Start focused session
                </Button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                    <span className="font-medium">From your games</span>
                    <Select
                        value={source}
                        onValueChange={(value) =>
                            setSource(value as SourceFocus)
                        }
                        disabled={disabled}
                    >
                        <SelectTrigger aria-label="Training source">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="SAVED">
                                My saved default
                            </SelectItem>
                            <SelectItem value="ALL">
                                All decisions
                            </SelectItem>
                            <SelectItem value="MY_MISTAKES">
                                My mistakes
                            </SelectItem>
                            <SelectItem value="MISSED_CHANCES">
                                Missed chances
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </label>

                <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Impact</span>
                    <Select
                        value={impact}
                        onValueChange={(value) =>
                            setImpact(value as TrainingSessionFocus)
                        }
                        disabled={disabled}
                    >
                        <SelectTrigger aria-label="Training impact">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ALL">
                                Every confirmed difference
                            </SelectItem>
                            <SelectItem value="MEANINGFUL">
                                Meaningful moments
                            </SelectItem>
                            <SelectItem value="MAJOR">
                                Major moments
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </label>
            </div>

            <details className="mt-3 rounded-lg border px-3 py-2 text-sm">
                <summary className="cursor-pointer select-none font-medium">
                    More focus options
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5">
                        <span className="font-medium">Game phase</span>
                        <Select
                            value={phase}
                            onValueChange={(value) =>
                                setPhase(value as PhaseFocus)
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger aria-label="Game phase">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ALL">
                                    Any phase
                                </SelectItem>
                                <SelectItem value="OPENING">
                                    Opening
                                </SelectItem>
                                <SelectItem value="MIDDLEGAME">
                                    Middlegame
                                </SelectItem>
                                <SelectItem value="ENDGAME">
                                    Endgame
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </label>

                    <label className="space-y-1.5">
                        <span className="font-medium">History</span>
                        <Select
                            value={history}
                            onValueChange={(value) =>
                                setHistory(value as HistoryFocus)
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger aria-label="Training history">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ALL">
                                    New and reviewed
                                </SelectItem>
                                <SelectItem value="FRESH">
                                    Not reviewed yet
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </label>
                </div>
            </details>
        </div>
    );
}
