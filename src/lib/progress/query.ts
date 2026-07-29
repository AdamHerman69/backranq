import {
    PROGRESS_PROVIDERS,
    PROGRESS_TIME_CLASSES,
    type ProgressFilters,
    type ProgressProvider,
    type ProgressRequest,
    type ProgressScope,
    type ProgressTimeClass,
} from '@/lib/progress/contracts';

const DEFAULT_SCOPE: ProgressScope = 90;
const ALLOWED_QUERY_KEYS = new Set([
    'scope',
    'provider',
    'timeClass',
]);

function parseScope(value: string | null): ProgressScope | null {
    if (value == null || value === '') return DEFAULT_SCOPE;
    if (value === '28') return 28;
    if (value === '90') return 90;
    if (value === 'all') return 'all';
    return null;
}

function parseEnumList<T extends string>(
    values: string[],
    allowed: readonly T[]
): T[] | null {
    const requested = values
        .flatMap((value) => value.split(','))
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
    if (
        requested.some(
            (value) => !allowed.includes(value as T)
        )
    ) {
        return null;
    }
    return Array.from(new Set(requested as T[]));
}

export function parseProgressRequest(
    url: URL,
    now = new Date()
): ProgressRequest | null {
    if (!Number.isFinite(now.getTime())) return null;
    if (
        Array.from(url.searchParams.keys()).some(
            (key) => !ALLOWED_QUERY_KEYS.has(key)
        )
    ) {
        return null;
    }
    const scope = parseScope(url.searchParams.get('scope'));
    const providers = parseEnumList<ProgressProvider>(
        url.searchParams.getAll('provider'),
        PROGRESS_PROVIDERS
    );
    const timeClasses = parseEnumList<ProgressTimeClass>(
        url.searchParams.getAll('timeClass'),
        PROGRESS_TIME_CLASSES
    );
    if (!scope || !providers || !timeClasses) {
        return null;
    }
    const filters: ProgressFilters = {
        providers,
        timeClasses,
    };
    // `asOf` is server-owned. Accepting a historical value would imply an
    // immutable snapshot even though current analysis/Position state is read.
    return { scope, asOf: new Date(now), filters };
}
