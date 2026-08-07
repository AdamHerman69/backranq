import Link from 'next/link';

import { Button } from '@/components/ui/button';
import type {
    ProgressAvailability,
    ProgressFilters,
    ProgressScope,
} from '@/lib/progress/contracts';
import { breakdownLabel } from '@/components/progress/model';

export function ProgressScopeForm({
    scope,
    filters,
    availability,
}: {
    scope: ProgressScope;
    filters: ProgressFilters;
    availability: ProgressAvailability;
}) {
    const hasFilters =
        filters.providers.length > 0 || filters.timeClasses.length > 0;
    const providerOptions = availability.providers.filter(
        (option) =>
            option.sourceGames > 0 ||
            option.terminalAttempts > 0 ||
            filters.providers.includes(option.key)
    );
    const timeClassOptions = availability.timeClasses.filter(
        (option) =>
            option.sourceGames > 0 ||
            option.terminalAttempts > 0 ||
            filters.timeClasses.includes(option.key)
    );
    const scopeLabel =
        scope === 'all'
            ? 'all retained data'
            : `the last ${scope} days`;
    const filterCount =
        filters.providers.length + filters.timeClasses.length;

    return (
        <form
            action="/progress"
            method="get"
            className="rounded-xl border bg-card p-4"
            aria-label="Progress scope"
        >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
                <label className="space-y-1.5 text-sm">
                    <span className="font-medium">Time window</span>
                    <select
                        name="scope"
                        defaultValue={String(scope)}
                        className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                        <option value="28">Last 28 days</option>
                        <option value="90">Last 90 days</option>
                        <option value="all">All retained data</option>
                    </select>
                </label>
                <div className="text-sm text-muted-foreground">
                    Games are included by when they were played. Practice
                    outcomes use when an attempt finished.
                </div>
            </div>

            <p
                className="mt-3 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
            >
                Current view: {scopeLabel}
                {filterCount > 0
                    ? ` with ${filterCount} active ${
                          filterCount === 1 ? 'filter' : 'filters'
                      }`
                    : ' across all available sources and time controls'}
                .
            </p>

            <details
                className="mt-4 rounded-lg border px-3 py-2"
                open={hasFilters || undefined}
            >
                <summary className="flex min-h-11 cursor-pointer select-none items-center text-sm font-medium">
                    Source and time-control filters
                    {hasFilters ? (
                        <span className="ml-2 font-normal text-muted-foreground">
                            · active
                        </span>
                    ) : null}
                </summary>
                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                    <fieldset>
                        <legend className="text-sm font-medium">Source</legend>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Leave all unchecked to include every source.
                        </p>
                        <div className="mt-2 space-y-2">
                            {providerOptions.length === 0 ? (
                                <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                                    No sources have games in this time
                                    window.
                                </p>
                            ) : null}
                            {providerOptions.map((option) => (
                                <label
                                    key={option.key}
                                    className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                                >
                                    <span>
                                        {breakdownLabel(
                                            'provider',
                                            option.key
                                        )}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <span className="text-right text-xs tabular-nums text-muted-foreground">
                                            {option.sourceGames} games ·{' '}
                                            {option.terminalAttempts} attempts
                                        </span>
                                        <input
                                            type="checkbox"
                                            name="provider"
                                            value={option.key}
                                            defaultChecked={filters.providers.includes(
                                                option.key
                                            )}
                                            className="h-4 w-4 accent-foreground"
                                        />
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <fieldset>
                        <legend className="text-sm font-medium">
                            Time control
                        </legend>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Leave all unchecked to include every time control.
                        </p>
                        <div className="mt-2 grid gap-2">
                            {timeClassOptions.length === 0 ? (
                                <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                                    No time controls are available in this time
                                    window.
                                </p>
                            ) : null}
                            {timeClassOptions.map((option) => (
                                <label
                                    key={option.key}
                                    className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                                >
                                    <span>
                                        {breakdownLabel(
                                            'timeClass',
                                            option.key
                                        )}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <span className="text-right text-xs tabular-nums text-muted-foreground">
                                            {option.sourceGames} games ·{' '}
                                            {option.terminalAttempts} attempts
                                        </span>
                                        <input
                                            type="checkbox"
                                            name="timeClass"
                                            value={option.key}
                                            defaultChecked={filters.timeClasses.includes(
                                                option.key
                                            )}
                                            className="h-4 w-4 accent-foreground"
                                        />
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                </div>
            </details>

            <div className="mt-4 flex flex-wrap gap-2">
                <Button type="submit" className="min-h-11">
                    Apply view
                </Button>
                {scope !== 90 || hasFilters ? (
                    <Button
                        asChild
                        type="button"
                        variant="outline"
                        className="min-h-11"
                    >
                        <Link href="/progress">Reset</Link>
                    </Button>
                ) : null}
            </div>
        </form>
    );
}
