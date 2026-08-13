import { SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
    ProgressAvailability,
    ProgressFilters,
    ProgressScope,
} from '@/lib/progress/contracts';
import { breakdownLabel } from '@/components/progress/model';

const scopeOptions = [
    { value: 28, label: '28 days' },
    { value: 90, label: '90 days' },
    { value: 'all', label: 'All time' },
] as const;

function progressHref(
    scope: ProgressScope,
    filters: ProgressFilters
) {
    const query = new URLSearchParams();
    if (scope !== 90) query.set('scope', String(scope));
    filters.providers.forEach((provider) =>
        query.append('provider', provider)
    );
    filters.timeClasses.forEach((timeClass) =>
        query.append('timeClass', timeClass)
    );
    const suffix = query.toString();
    return suffix ? `/progress?${suffix}` : '/progress';
}

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
            className="border-y border-foreground/10 bg-card/35 py-3 sm:py-4"
            aria-label="Progress scope"
        >
            {scope !== 90 ? (
                <input type="hidden" name="scope" value={String(scope)} />
            ) : null}

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div
                    className="grid grid-cols-3 rounded-md bg-surface-subtle p-1"
                    role="group"
                    aria-label="Time window"
                >
                    {scopeOptions.map((option) => {
                        const isCurrent = option.value === scope;
                        return (
                            <Button
                                key={option.value}
                                asChild
                                type="button"
                                size="sm"
                                variant={isCurrent ? 'default' : 'ghost'}
                                className="min-h-11 px-3 sm:min-h-10"
                            >
                                {/* This server-filter navigation must also work before hydration. */}
                                <a
                                    href={progressHref(
                                        option.value,
                                        filters
                                    )}
                                    aria-current={
                                        isCurrent ? 'page' : undefined
                                    }
                                >
                                    {option.label}
                                </a>
                            </Button>
                        );
                    })}
                </div>
                <p
                    className="text-xs leading-relaxed text-muted-foreground lg:max-w-xl lg:text-right"
                    role="status"
                    aria-live="polite"
                >
                    Current view: {scopeLabel}
                    {filterCount > 0
                        ? ` with ${filterCount} active ${
                              filterCount === 1 ? 'filter' : 'filters'
                          }`
                        : ' across all sources and time controls'}
                    . Games use played time; Practice uses completion time.
                </p>
            </div>

            <details
                className="group mt-3 rounded-md border border-transparent open:border-border open:bg-surface-subtle"
                open={hasFilters || undefined}
            >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2">
                        <SlidersHorizontal
                            className="h-4 w-4 text-muted-foreground"
                            aria-hidden="true"
                        />
                        Source and time control
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                        {hasFilters
                            ? `${filterCount} active`
                            : 'Optional filters'}
                    </span>
                </summary>
                <div className="grid gap-5 border-t p-3 sm:grid-cols-2 sm:p-4">
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
                                    className="flex min-h-11 items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/25"
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
                                            className="h-4 w-4 accent-primary"
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
                                    className="flex min-h-11 items-center justify-between gap-3 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/25"
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
                                            className="h-4 w-4 accent-primary"
                                        />
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <Button type="submit" className="min-h-11">
                            Apply filters
                        </Button>
                        {scope !== 90 || hasFilters ? (
                            <Button
                                asChild
                                type="button"
                                variant="outline"
                                className="min-h-11"
                            >
                                <a href="/progress">Reset view</a>
                            </Button>
                        ) : null}
                    </div>
                </div>
            </details>
        </form>
    );
}
