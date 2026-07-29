import {
    PROGRESS_PROVIDERS,
    PROGRESS_SCOPES,
    PROGRESS_TIME_CLASSES,
    type ProgressFilters,
    type ProgressProvider,
    type ProgressScope,
    type ProgressTimeClass,
} from '@/lib/progress/contracts';

export type ProgressSearchParams = Record<
    string,
    string | string[] | undefined
>;

function values(value: string | string[] | undefined) {
    return (Array.isArray(value) ? value : value ? [value] : []).map(
        (item) => item.trim().toUpperCase()
    );
}
export function parseProgressSearchParams(
    searchParams: ProgressSearchParams
): {
    scope: ProgressScope;
    filters: ProgressFilters;
    canonicalQuery: string;
} {
    const rawScope =
        typeof searchParams.scope === 'string'
            ? searchParams.scope.trim().toLowerCase()
            : '';
    const scope: ProgressScope = (
        PROGRESS_SCOPES.map(String) as string[]
    ).includes(rawScope)
        ? rawScope === 'all'
            ? 'all'
            : (Number(rawScope) as 28 | 90)
        : 90;

    const providers = Array.from(
        new Set(
            values(searchParams.provider).filter(
                (value): value is ProgressProvider =>
                    (PROGRESS_PROVIDERS as readonly string[]).includes(value)
            )
        )
    );
    const timeClasses = Array.from(
        new Set(
            values(searchParams.timeClass).filter(
                (value): value is ProgressTimeClass =>
                    (PROGRESS_TIME_CLASSES as readonly string[]).includes(
                        value
                    )
            )
        )
    );
    const canonical = new URLSearchParams();
    if (scope !== 90) canonical.set('scope', String(scope));
    for (const provider of providers) canonical.append('provider', provider);
    for (const timeClass of timeClasses) {
        canonical.append('timeClass', timeClass);
    }
    return {
        scope,
        filters: { providers, timeClasses },
        canonicalQuery: canonical.toString(),
    };
}
