import type { Provider, TimeClass } from '@prisma/client';
import {
    canonicalPreferences,
    type AutoAnalysisPolicy,
    type AutoAnalysisProviderKey,
    type AutoAnalysisResultScope,
    type AutoAnalysisTimeControlKey,
} from '@/lib/preferences';

export type ProviderKey = AutoAnalysisProviderKey;
export type TimeControlKey = AutoAnalysisTimeControlKey;
export type AutoAnalysisRules = AutoAnalysisPolicy;

export type AutoAnalysisGameCandidate = {
    id?: string;
    provider: Provider | ProviderKey;
    result?: string | null;
    timeClass: TimeClass | TimeControlKey;
    rated?: boolean | null;
    pgn?: string | null;
    whiteName?: string | null;
    blackName?: string | null;
    createdAt?: Date | string | null;
    white?: { name?: string | null };
    black?: { name?: string | null };
};

export type AutoAnalysisEligibility = {
    eligible: boolean;
    reason: string | null;
    priority: number;
    rules: AutoAnalysisRules;
};

export function autoAnalysisRulesFromPreferences(
    preferences: unknown
): AutoAnalysisRules {
    return canonicalPreferences(preferences).autoAnalysis;
}

export function evaluateAutoAnalysisEligibility(args: {
    preferences: unknown;
    game: AutoAnalysisGameCandidate;
    username?: string | null;
    usernameByProvider?: Partial<Record<ProviderKey, string | null>>;
}): AutoAnalysisEligibility {
    const rules = autoAnalysisRulesFromPreferences(args.preferences);
    const provider = providerKey(args.game.provider);
    const timeControl = timeControlKey(args.game.timeClass);
    const plies = countPgnPlies(args.game.pgn ?? '');
    const perspective = perspectiveResult(
        args.game,
        args.usernameByProvider?.[provider] ?? args.username
    );

    if (!rules.enabled) return ineligible(rules, 'disabled');
    if (
        rules.backlogMode === 'new' &&
        rules.enabledAt &&
        (!args.game.createdAt ||
            new Date(args.game.createdAt).getTime() <
                new Date(rules.enabledAt).getTime())
    ) {
        return ineligible(rules, 'before-enabled');
    }
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
        usernameByProvider?: Partial<Record<ProviderKey, string | null>>;
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
                usernameByProvider: args.usernameByProvider,
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
    const user = normalizeName(username);
    if (!user) return 'unknown';
    const white = normalizeName(game.whiteName ?? game.white?.name);
    const black = normalizeName(game.blackName ?? game.black?.name);
    if (user !== white && user !== black) return 'unknown';
    if (result === '1/2-1/2') return 'draw';
    if (result !== '1-0' && result !== '0-1') return 'unknown';
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

function normalizeName(value: unknown) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
