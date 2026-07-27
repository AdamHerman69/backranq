import type { Provider, TimeClass } from '@prisma/client';

export type AutoAnalysisResultScope = 'losses' | 'draws' | 'all';
export type ProviderKey = 'lichess' | 'chesscom';
export type TimeControlKey =
    | 'bullet'
    | 'blitz'
    | 'rapid'
    | 'classical'
    | 'unknown';

export type AutoAnalysisRules = {
    enabled: boolean;
    providers: Record<ProviderKey, boolean>;
    resultScope: AutoAnalysisResultScope;
    timeControls: Record<TimeControlKey, boolean>;
    ratedOnly: boolean;
    minPlies: number;
    dailyCap: number | null;
    monthlyCap: number | null;
};

export type AutoAnalysisGameCandidate = {
    id?: string;
    provider: Provider | ProviderKey;
    result?: string | null;
    timeClass: TimeClass | TimeControlKey;
    rated?: boolean | null;
    pgn?: string | null;
    whiteName?: string | null;
    blackName?: string | null;
    white?: { name?: string | null };
    black?: { name?: string | null };
};

export type AutoAnalysisEligibility = {
    eligible: boolean;
    reason: string | null;
    priority: number;
    rules: AutoAnalysisRules;
};

const DEFAULT_TIME_CONTROLS: Record<TimeControlKey, boolean> = {
    bullet: false,
    blitz: true,
    rapid: true,
    classical: true,
    unknown: false,
};

const TIME_CONTROLS: TimeControlKey[] = [
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'unknown',
];

export function autoAnalysisRulesFromPreferences(
    preferences: unknown
): AutoAnalysisRules {
    const prefs = record(preferences) ?? {};
    const nested = record(prefs.autoAnalysis) ?? {};
    const enabled =
        prefs.autoAnalyzeEnabled === true || nested.enabled === true;
    const providerPrefs =
        record(prefs.autoAnalyzeProviders) ??
        record(prefs.autoAnalysisProviders) ??
        record(nested.providers) ??
        record(prefs.autoSyncProviders);
    const timeControlPrefs =
        prefs.autoAnalyzeTimeControls ??
        prefs.autoAnalysisTimeControls ??
        nested.timeControls;

    return {
        enabled,
        providers: normalizeProviders(providerPrefs),
        resultScope: normalizeResultScope(
            nested.resultScope ?? prefs.autoAnalyzeResultScope
        ),
        timeControls: normalizeTimeControls(timeControlPrefs),
        ratedOnly: normalizeBoolean(
            nested.ratedOnly ?? prefs.autoAnalyzeRatedOnly,
            true
        ),
        minPlies: normalizeNonNegativeInteger(
            nested.minPlies ?? prefs.autoAnalyzeMinPlies,
            20
        ),
        dailyCap: normalizeNullablePositiveInteger(
            nested.dailyCap ?? prefs.autoAnalyzeDailyCap
        ),
        monthlyCap: normalizeNullablePositiveInteger(
            nested.monthlyCap ?? prefs.autoAnalyzeMonthlyCap
        ),
    };
}

export function evaluateAutoAnalysisEligibility(args: {
    preferences: unknown;
    game: AutoAnalysisGameCandidate;
    username?: string | null;
}): AutoAnalysisEligibility {
    const rules = autoAnalysisRulesFromPreferences(args.preferences);
    const provider = providerKey(args.game.provider);
    const timeControl = timeControlKey(args.game.timeClass);
    const plies = countPgnPlies(args.game.pgn ?? '');
    const perspective = perspectiveResult(args.game, args.username);

    if (!rules.enabled) return ineligible(rules, 'disabled');
    if (!rules.providers[provider]) return ineligible(rules, 'provider');
    if (!rules.timeControls[timeControl]) {
        return ineligible(rules, 'time-control');
    }
    if (rules.ratedOnly && args.game.rated !== true) {
        return ineligible(rules, 'rated-only');
    }
    if (plies < rules.minPlies) return ineligible(rules, 'min-plies');
    if (!resultInScope(rules.resultScope, perspective)) {
        return ineligible(rules, 'result-scope');
    }

    return {
        eligible: true,
        reason: null,
        priority: autoAnalysisPriority({
            scope: rules.resultScope,
            perspective,
            timeControl,
            rated: args.game.rated === true,
            plies,
        }),
        rules,
    };
}

export function eligibleAutoAnalysisGameIds<T extends AutoAnalysisGameCandidate>(
    args: {
        preferences: unknown;
        games: T[];
        gameId: (game: T) => string | null | undefined;
        username?: string | null;
    }
) {
    return args.games
        .map((game) => ({
            game,
            gameId: args.gameId(game),
            eligibility: evaluateAutoAnalysisEligibility({
                preferences: args.preferences,
                game,
                username: args.username,
            }),
        }))
        .filter(
            (
                item
            ): item is {
                game: T;
                gameId: string;
                eligibility: AutoAnalysisEligibility & {
                    eligible: true;
                    reason: null;
                };
            } => !!item.gameId && item.eligibility.eligible
        );
}

function ineligible(
    rules: AutoAnalysisRules,
    reason: string
): AutoAnalysisEligibility {
    return { eligible: false, reason, priority: 0, rules };
}

function normalizeProviders(
    value: Record<string, unknown> | null
): Record<ProviderKey, boolean> {
    if (!value) return { lichess: true, chesscom: true };
    return {
        lichess: normalizeBoolean(value.lichess, false),
        chesscom: normalizeBoolean(value.chesscom, false),
    };
}

function normalizeTimeControls(value: unknown): Record<TimeControlKey, boolean> {
    if (Array.isArray(value)) {
        const selected = new Set(
            value.filter((item): item is TimeControlKey =>
                TIME_CONTROLS.includes(item as TimeControlKey)
            )
        );
        return Object.fromEntries(
            TIME_CONTROLS.map((key) => [key, selected.has(key)])
        ) as Record<TimeControlKey, boolean>;
    }
    const entries = record(value);
    if (!entries) return { ...DEFAULT_TIME_CONTROLS };
    return Object.fromEntries(
        TIME_CONTROLS.map((key) => [
            key,
            normalizeBoolean(entries[key], DEFAULT_TIME_CONTROLS[key]),
        ])
    ) as Record<TimeControlKey, boolean>;
}

function normalizeResultScope(value: unknown): AutoAnalysisResultScope {
    if (value === 'all' || value === 'draws' || value === 'losses') {
        return value;
    }
    return 'losses';
}

function resultInScope(
    scope: AutoAnalysisResultScope,
    perspective: 'win' | 'loss' | 'draw' | 'unknown'
) {
    if (scope === 'all') return perspective !== 'unknown';
    if (scope === 'draws') return perspective === 'loss' || perspective === 'draw';
    return perspective === 'loss';
}

function perspectiveResult(
    game: AutoAnalysisGameCandidate,
    username?: string | null
): 'win' | 'loss' | 'draw' | 'unknown' {
    const result = (game.result ?? '').trim();
    if (result === '1/2-1/2') return 'draw';
    if (result !== '1-0' && result !== '0-1') return 'unknown';

    const user = normalizeName(username);
    if (!user) return 'unknown';
    const white = normalizeName(game.whiteName ?? game.white?.name);
    const black = normalizeName(game.blackName ?? game.black?.name);
    if (user === white) return result === '1-0' ? 'win' : 'loss';
    if (user === black) return result === '0-1' ? 'win' : 'loss';
    return 'unknown';
}

function autoAnalysisPriority(args: {
    scope: AutoAnalysisResultScope;
    perspective: 'win' | 'loss' | 'draw' | 'unknown';
    timeControl: TimeControlKey;
    rated: boolean;
    plies: number;
}) {
    let priority = 0;
    if (args.perspective === 'loss') priority += 40;
    if (args.perspective === 'draw') priority += 20;
    if (args.rated) priority += 10;
    if (args.timeControl === 'classical') priority += 8;
    if (args.timeControl === 'rapid') priority += 6;
    if (args.timeControl === 'blitz') priority += 3;
    if (args.scope === 'all') priority -= 5;
    priority += Math.min(10, Math.floor(args.plies / 20));
    return priority;
}

export function countPgnPlies(pgn: string) {
    const moves = pgn
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\$\d+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !/^\d+\.(\.\.)?$/.test(token))
        .filter((token) => !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token))
        .filter((token) => token !== '...');
    return moves.length;
}

function providerKey(provider: Provider | ProviderKey): ProviderKey {
    return provider === 'LICHESS' || provider === 'lichess'
        ? 'lichess'
        : 'chesscom';
}

function timeControlKey(timeClass: TimeClass | TimeControlKey): TimeControlKey {
    switch (timeClass) {
        case 'BULLET':
        case 'bullet':
            return 'bullet';
        case 'BLITZ':
        case 'blitz':
            return 'blitz';
        case 'RAPID':
        case 'rapid':
            return 'rapid';
        case 'CLASSICAL':
        case 'classical':
            return 'classical';
        default:
            return 'unknown';
    }
}

function normalizeBoolean(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.max(0, Math.trunc(n));
}

function normalizeNullablePositiveInteger(value: unknown) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    const int = Math.trunc(n);
    return int > 0 ? int : null;
}

function normalizeName(value: unknown) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
