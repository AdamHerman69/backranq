import type {
    ProgressBreakdownRow,
    ProgressPositionAction,
    ProgressRate,
    ProgressSampleState,
    ProgressSnapshot,
    ProgressTrend,
} from '@/lib/progress/contracts';
import type { ProgressAnalyticsWrite } from '@/lib/progress/analytics';

type ActionEvent = Extract<
    ProgressAnalyticsWrite,
    { eventName: 'ACTION_CLICKED' }
>;

export type ProgressNextAction = {
    title: string;
    description: string;
    label: string;
    href: string;
    recommendationKey?: ActionEvent['recommendationKey'];
};

const PROVIDER_QUERY: Record<string, string> = {
    LICHESS: 'lichess',
    CHESSCOM: 'chesscom',
    MANUAL_PGN: 'manual_pgn',
    BACKRANQ_COACH: 'backranq_coach',
};

const TIME_CLASS_QUERY: Record<string, string> = {
    BULLET: 'bullet',
    BLITZ: 'blitz',
    RAPID: 'rapid',
    CLASSICAL: 'classical',
    UNKNOWN: 'unknown',
};

export function practiceHref(positionId?: string) {
    const query = new URLSearchParams({ entry: 'progress' });
    if (positionId) query.set('momentId', positionId);
    return `/practice?${query.toString()}`;
}

export function gamesHref(
    snapshot: Pick<ProgressSnapshot, 'filters' | 'window'>,
    options: { unanalyzed?: boolean } = {}
) {
    const query = new URLSearchParams();
    if (snapshot.filters.providers.length === 1) {
        const provider = PROVIDER_QUERY[snapshot.filters.providers[0]];
        if (provider) query.set('provider', provider);
    }
    if (snapshot.filters.timeClasses.length === 1) {
        const timeClass = TIME_CLASS_QUERY[snapshot.filters.timeClasses[0]];
        if (timeClass) query.set('timeClass', timeClass);
    }
    if (snapshot.window.from) {
        query.set('since', snapshot.window.from.slice(0, 10));
        query.set('until', snapshot.window.asOf.slice(0, 10));
    }
    if (options.unanalyzed) {
        query.set('analysisState', 'needs-analysis');
    }
    const suffix = query.toString();
    return suffix ? `/games?${suffix}` : '/games';
}

function firstAttemptedPosition(snapshot: ProgressSnapshot) {
    return (
        snapshot.actions.needsAnotherLook[0] ??
        snapshot.actions.persistentOriginalMoveRepetition[0] ??
        null
    );
}

export function deriveProgressNextAction(
    snapshot: ProgressSnapshot
): ProgressNextAction {
    const hasPracticeEvidence =
        snapshot.practice.gradedAttempts +
            snapshot.practice.revealedAttempts +
            snapshot.practice.unresolvedExcluded >
        0;
    const hasCurrentInventory =
        snapshot.inventory.eligiblePositions > 0;

    if (
        snapshot.availability.filteredEmpty &&
        !hasPracticeEvidence &&
        !hasCurrentInventory
    ) {
        return {
            title: 'No source games match this view',
            description:
                'Your library still has data. Clear the filters to return to the full picture.',
            label: 'Show all Progress',
            href: '/progress',
            recommendationKey: 'show-all-progress',
        };
    }

    if (
        snapshot.coverage.analyzedRate.n === 0 &&
        snapshot.availability.hasDataOutsideScope &&
        !hasPracticeEvidence &&
        !hasCurrentInventory
    ) {
        return {
            title: 'No source games in this time window',
            description:
                'Your library has older data. Switch to all time to include it.',
            label: 'Show all time',
            href: '/progress?scope=all',
            recommendationKey: 'show-all-time',
        };
    }

    if (snapshot.operational.primaryState === 'NO_LINKED_ACCOUNT') {
        return {
            title: 'Connect a chess account',
            description:
                'Link Lichess or Chess.com before Progress can learn from your games.',
            label: 'Open Settings',
            href: '/settings',
            recommendationKey: 'connect-account',
        };
    }

    if (snapshot.operational.primaryState === 'NO_GAMES') {
        return {
            title: 'Bring in your first games',
            description:
                'Syncing is free. Imported games become useful here after analysis finds personal Positions.',
            label: 'Go to Games',
            href: gamesHref(snapshot),
            recommendationKey: 'view-games',
        };
    }

    if (snapshot.inventory.eligiblePositions > 0) {
        const attemptedPosition = firstAttemptedPosition(snapshot);
        if (attemptedPosition) {
            return {
                title: 'Take another look at a reviewed Position',
                description:
                    'This Position is already in your attempt history. Open it without revealing a fresh Position’s theme or answer.',
                label: 'Review Position',
                href: practiceHref(attemptedPosition.positionId),
                recommendationKey: 'review-position',
            };
        }
        if (snapshot.inventory.fresh > 0) {
            return {
                title: 'Use the evidence in Practice',
                description:
                    'Continue with a mixed, spoiler-safe feed. Progress does not reveal what kind of decision comes next.',
                label: 'Continue Practice',
                href: practiceHref(),
                recommendationKey: 'mixed-practice',
            };
        }
        return {
            title: 'You are caught up',
            description:
                'There are no fresh Positions in this view. Revisit your mixed Practice feed whenever you want another look.',
            label: 'Review in Practice',
            href: practiceHref(),
            recommendationKey: 'mixed-practice',
        };
    }

    if (snapshot.operational.primaryState === 'WAITING_FOR_CREDITS') {
        return {
            title: 'Your games are safe and waiting for analysis',
            description:
                'Server credits are exhausted. You can still analyze the same games free in your browser.',
            label: 'Analyze in Games',
            href: gamesHref(snapshot, { unanalyzed: true }),
            recommendationKey: 'analyze-games',
        };
    }

    if (
        snapshot.operational.primaryState === 'ANALYSIS_RUNNING' ||
        snapshot.operational.primaryState === 'ANALYSIS_QUEUED'
    ) {
        return {
            title: 'Analysis is preparing your Positions',
            description:
                'You can leave server work running, or open Games to inspect the current queue.',
            label: 'View Games',
            href: gamesHref(snapshot, { unanalyzed: true }),
            recommendationKey: 'view-games',
        };
    }

    if (snapshot.operational.primaryState === 'ANALYSIS_FAILED') {
        return {
            title: 'Some games still need analysis',
            description:
                'Review the failed or unfinished games before treating this Progress view as complete.',
            label: 'Review Games',
            href: gamesHref(snapshot, { unanalyzed: true }),
            recommendationKey: 'analyze-games',
        };
    }

    if (snapshot.operational.primaryState === 'NO_ANALYSIS') {
        return {
            title: 'Analyze your imported games',
            description:
                'Progress cannot compare decisions until analysis has produced eligible Positions.',
            label: 'Choose analysis',
            href: gamesHref(snapshot, { unanalyzed: true }),
            recommendationKey: 'analyze-games',
        };
    }

    return {
        title: 'No eligible Positions in this view',
        description:
            'The analyzed games did not produce a Position under your current settings.',
        label: 'Review Position settings',
        href: '/settings',
    };
}

export function formatProgressRate(rate: ProgressRate) {
    if (rate.n === 0) return 'No observations yet';
    if (rate.rate == null) return `${rate.x} of ${rate.n}`;
    return `${Math.round(rate.rate * 100)}% · ${rate.x} of ${rate.n}`;
}

export function sampleStateLabel(state: ProgressSampleState) {
    if (state === 'COUNTS_ONLY') {
        return 'Small sample — counts only until 10 observations';
    }
    if (state === 'EARLY_SIGNAL') {
        return 'Early signal — interpret cautiously until 50 observations';
    }
    return 'Established sample';
}

export function confidenceLabel(rate: ProgressRate) {
    if (!rate.confidence95) return null;
    return `95% confidence interval ${Math.round(
        rate.confidence95.low * 100
    )}–${Math.round(rate.confidence95.high * 100)}%`;
}

const TREND_REASON_LABELS: Record<
    Exclude<ProgressTrend['reason'], 'AVAILABLE'>,
    string
> = {
    ALL_TIME_SCOPE: 'All-time views do not have a comparable previous period.',
    CURRENT_SAMPLE_TOO_SMALL:
        'Trend hidden until the current period has 50 observations.',
    PREVIOUS_SAMPLE_TOO_SMALL:
        'Trend hidden until the previous period has 50 observations.',
    CONFIG_CHANGED:
        'Trend hidden because the analysis configuration changed.',
    COVERAGE_CHANGED:
        'Trend hidden because analysis coverage changed too much.',
    MIX_CHANGED:
        'Trend hidden because the mix of games changed too much.',
};

export function formatTrend(trend: ProgressTrend) {
    if (trend.status === 'HIDDEN' || trend.difference == null) {
        return trend.reason === 'AVAILABLE'
            ? 'No comparable trend is available.'
            : TREND_REASON_LABELS[trend.reason];
    }
    const points = Math.round(Math.abs(trend.difference) * 100);
    const interval = trend.confidence95Difference
        ? ` The 95% interval for the difference is ${Math.round(
              trend.confidence95Difference.low * 100
          )} to ${Math.round(
              trend.confidence95Difference.high * 100
          )} percentage points.`
        : '';
    if (trend.direction === 'NO_CLEAR_CHANGE') {
        return `No clear change from the previous period (${points} percentage-point difference).${interval}`;
    }
    return `${
        trend.direction === 'UP' ? 'Higher' : 'Lower'
    } than the previous period by ${points} percentage points.${interval}`;
}

export function breakdownLabel(kind: string, key: string) {
    const labels: Record<string, string> = {
        OPENING: 'Opening',
        MIDDLEGAME: 'Middlegame',
        ENDGAME: 'Endgame',
        UNKNOWN: 'Unknown',
        LICHESS: 'Lichess',
        CHESSCOM: 'Chess.com',
        MANUAL_PGN: 'Manual PGN',
        BACKRANQ_COACH: 'Backranq Coach',
        BULLET: 'Bullet',
        BLITZ: 'Blitz',
        RAPID: 'Rapid',
        CLASSICAL: 'Classical',
        MY_MISTAKE: 'Your game decision',
        MISSED_OPPORTUNITY: 'Missed opportunity',
        WIN_CHANCE_LOW: 'Lower impact (winning chance)',
        WIN_CHANCE_MEANINGFUL: 'Meaningful impact (winning chance)',
        WIN_CHANCE_MAJOR: 'Major impact (winning chance)',
        CENTIPAWN_FALLBACK_LOW: 'Lower impact (centipawn fallback)',
        CENTIPAWN_FALLBACK_MEANINGFUL:
            'Meaningful impact (centipawn fallback)',
        CENTIPAWN_FALLBACK_MAJOR: 'Major impact (centipawn fallback)',
    };
    if (labels[key]) return labels[key];
    if (kind === 'source') {
        return key
            .toLowerCase()
            .split('_')
            .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
            .join(' ');
    }
    return key;
}

export function sortBreakdownRows(rows: ProgressBreakdownRow[]) {
    return rows
        .filter(
            (row) =>
                row.positions > 0 ||
                row.sourceGames > 0 ||
                row.gradedAttempts > 0
        )
        .sort(
            (a, b) =>
                b.positions - a.positions ||
                b.gradedAttempts - a.gradedAttempts ||
                a.key.localeCompare(b.key)
        );
}

export function positionActionLabel(action: ProgressPositionAction) {
    if (action.reason === 'PERSISTENT_ORIGINAL_MOVE_REPETITION') {
        return 'The original move has recurred across reviews';
    }
    if (action.reason === 'LATEST_ORIGINAL_MOVE_REPEATED') {
        return 'The latest review repeated the original move';
    }
    if (action.reason === 'REVEALED_WITHOUT_LATER_SOLVE') {
        return 'Revealed and not yet solved later';
    }
    return 'The latest full Position was not solved';
}
