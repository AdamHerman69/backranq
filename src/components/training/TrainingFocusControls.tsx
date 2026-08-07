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
    PracticeFeedFocus,
    PracticeFeedMode,
    PracticeFilters,
    TrainingPhase,
} from '@/lib/training/api';

export type PracticeFocusControlState = {
    source: 'SAVED' | 'ALL' | 'MY_MISTAKES' | 'MISSED_CHANCES';
    impact: PracticeFeedFocus;
    phase: 'ALL' | TrainingPhase;
    mode: PracticeFeedMode;
};

export function filtersForPracticeFocus({
    source,
    impact,
    phase,
    mode,
}: {
    source: PracticeFocusControlState['source'];
    impact: PracticeFeedFocus;
    phase: PracticeFocusControlState['phase'];
    mode: PracticeFocusControlState['mode'];
}): PracticeFilters {
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
        mode,
    };
}

export function controlStateForPracticeFilters(
    filters: PracticeFilters
): PracticeFocusControlState {
    const sourceKinds = new Set(filters.sourceKinds ?? []);
    const source =
        filters.sourceKinds === undefined
            ? 'SAVED'
            : sourceKinds.has('MY_MISTAKE') &&
                sourceKinds.has('MISSED_OPPORTUNITY')
              ? 'ALL'
              : sourceKinds.has('MY_MISTAKE')
                ? 'MY_MISTAKES'
                : sourceKinds.has('MISSED_OPPORTUNITY')
                  ? 'MISSED_CHANCES'
                  : 'ALL';

    return {
        source,
        impact: filters.focus ?? 'ALL',
        phase:
            filters.phases?.length === 1
                ? filters.phases[0]
                : 'ALL',
        mode: filters.mode ?? 'RECOMMENDED',
    };
}

export function hasEffectivePracticeFocus(
    requestedFilters: PracticeFilters,
    appliedFilters: PracticeFilters
): boolean {
    return [requestedFilters, appliedFilters].some(
        (filters) =>
            filters.focus === 'MEANINGFUL' ||
            filters.focus === 'MAJOR' ||
            Boolean(filters.sourceKinds?.length) ||
            Boolean(filters.phases?.length) ||
            Boolean(filters.lessonKinds?.length) ||
            Boolean(filters.themes?.length) ||
            filters.minConfidence !== undefined ||
            (filters.mode ?? 'RECOMMENDED') !== 'RECOMMENDED'
    );
}

export function TrainingFocusControls({
    disabled,
    filters,
    onApply,
}: {
    disabled: boolean;
    filters: PracticeFilters;
    onApply: (filters: PracticeFilters) => void;
}) {
    const [controls, setControls] = useState<PracticeFocusControlState>(
        () => controlStateForPracticeFilters(filters)
    );

    const filtersToApply = useMemo(
        () =>
            filtersForPracticeFocus({
                source: controls.source,
                impact: controls.impact,
                phase: controls.phase,
                mode: controls.mode,
            }),
        [controls]
    );

    return (
        <div
            className="rounded-xl border bg-card p-4"
            aria-label="Position focus"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2 font-medium">
                        <SlidersHorizontal
                            className="h-4 w-4"
                            aria-hidden="true"
                        />
                        Position focus
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Choose which saved positions to practise now. Your
                        other positions stay available.
                    </p>
                </div>
                <Button
                    type="button"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onApply(filtersToApply)}
                >
                    Apply focus
                </Button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                    <span className="font-medium">From your games</span>
                    <Select
                        value={controls.source}
                        onValueChange={(value) =>
                            setControls((current) => ({
                                ...current,
                                source:
                                    value as PracticeFocusControlState['source'],
                            }))
                        }
                        disabled={disabled}
                    >
                        <SelectTrigger aria-label="Position source">
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
                        value={controls.impact}
                        onValueChange={(value) =>
                            setControls((current) => ({
                                ...current,
                                impact: value as PracticeFeedFocus,
                            }))
                        }
                        disabled={disabled}
                    >
                        <SelectTrigger aria-label="Position impact">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ALL">
                                Every confirmed difference
                            </SelectItem>
                            <SelectItem value="MEANINGFUL">
                                Meaningful positions
                            </SelectItem>
                            <SelectItem value="MAJOR">
                                Major positions
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
                            value={controls.phase}
                            onValueChange={(value) =>
                                setControls((current) => ({
                                    ...current,
                                    phase:
                                        value as PracticeFocusControlState['phase'],
                                }))
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
                        <span className="font-medium">Queue</span>
                        <Select
                            value={controls.mode}
                            onValueChange={(value) =>
                                setControls((current) => ({
                                    ...current,
                                    mode:
                                        value as PracticeFocusControlState['mode'],
                                }))
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger aria-label="Practice queue">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="RECOMMENDED">
                                    Recommended mix
                                </SelectItem>
                                <SelectItem value="REVIEW">
                                    Due for review
                                </SelectItem>
                                <SelectItem value="NEW">
                                    New positions
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </label>
                </div>
            </details>
        </div>
    );
}
