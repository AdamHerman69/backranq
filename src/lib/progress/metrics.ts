import type {
    ProgressRate,
    ProgressScope,
    ProgressTrend,
    ProgressWindow,
} from '@/lib/progress/contracts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WILSON_Z_95 = 1.959963984540054;

function assertCount(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
}

export function wilson95(x: number, n: number) {
    assertCount(x, 'x');
    assertCount(n, 'n');
    if (x > n) throw new Error('x cannot exceed n');
    if (n === 0) return null;

    const p = x / n;
    const z2 = WILSON_Z_95 ** 2;
    const denominator = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denominator;
    const halfWidth =
        (WILSON_Z_95 *
            Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) /
        denominator;
    return {
        low: Math.max(0, center - halfWidth),
        high: Math.min(1, center + halfWidth),
    };
}

export function progressRate(x: number, n: number): ProgressRate {
    assertCount(x, 'x');
    assertCount(n, 'n');
    if (x > n) throw new Error('x cannot exceed n');
    if (n < 10) {
        return {
            x,
            n,
            rate: null,
            sampleState: 'COUNTS_ONLY',
            confidence95: null,
        };
    }
    return {
        x,
        n,
        rate: x / n,
        sampleState: n < 50 ? 'EARLY_SIGNAL' : 'ESTABLISHED',
        confidence95: wilson95(x, n),
    };
}

/**
 * Newcombe's score interval for the difference between two independent
 * proportions, built from Wilson score limits without continuity correction.
 */
export function newcombeWilson95Difference(
    currentX: number,
    currentN: number,
    previousX: number,
    previousN: number
) {
    assertCount(currentX, 'currentX');
    assertCount(currentN, 'currentN');
    assertCount(previousX, 'previousX');
    assertCount(previousN, 'previousN');
    if (currentX > currentN || previousX > previousN) {
        throw new Error('successes cannot exceed observations');
    }
    if (currentN === 0 || previousN === 0) return null;

    const currentRate = currentX / currentN;
    const previousRate = previousX / previousN;
    const currentInterval = wilson95(currentX, currentN);
    const previousInterval = wilson95(previousX, previousN);
    if (!currentInterval || !previousInterval) return null;

    const difference = currentRate - previousRate;
    return {
        low: Math.max(
            -1,
            difference -
                Math.sqrt(
                    (currentRate - currentInterval.low) ** 2 +
                        (previousInterval.high - previousRate) ** 2
                )
        ),
        high: Math.min(
            1,
            difference +
                Math.sqrt(
                    (currentInterval.high - currentRate) ** 2 +
                        (previousRate - previousInterval.low) ** 2
                )
        ),
    };
}

export function progressTrend(args: {
    current: ProgressRate;
    previous: ProgressRate | null;
    allTime: boolean;
    comparableConfig: boolean;
    comparableCoverage: boolean;
    comparableMix: boolean;
}): ProgressTrend {
    const hidden = (
        reason: Exclude<ProgressTrend['reason'], 'AVAILABLE'>
    ): ProgressTrend => ({
        status: 'HIDDEN',
        reason,
        current: args.current,
        previous: args.previous,
        difference: null,
        confidence95Difference: null,
        direction: null,
    });
    if (args.allTime) return hidden('ALL_TIME_SCOPE');
    if (args.current.n < 50) return hidden('CURRENT_SAMPLE_TOO_SMALL');
    if (!args.previous || args.previous.n < 50) {
        return hidden('PREVIOUS_SAMPLE_TOO_SMALL');
    }
    if (!args.comparableConfig) return hidden('CONFIG_CHANGED');
    if (!args.comparableCoverage) return hidden('COVERAGE_CHANGED');
    if (!args.comparableMix) return hidden('MIX_CHANGED');

    const currentRate = args.current.rate;
    const previousRate = args.previous.rate;
    if (
        currentRate == null ||
        previousRate == null
    ) {
        return hidden('CURRENT_SAMPLE_TOO_SMALL');
    }
    const confidence95Difference = newcombeWilson95Difference(
        args.current.x,
        args.current.n,
        args.previous.x,
        args.previous.n
    );
    if (!confidence95Difference) {
        return hidden('CURRENT_SAMPLE_TOO_SMALL');
    }
    return {
        status: 'SHOWN',
        reason: 'AVAILABLE',
        current: args.current,
        previous: args.previous,
        difference: currentRate - previousRate,
        confidence95Difference,
        direction:
            confidence95Difference.low > 0
                ? 'UP'
                : confidence95Difference.high < 0
                  ? 'DOWN'
                  : 'NO_CLEAR_CHANGE',
    };
}

export function progressWindow(
    scope: ProgressScope,
    asOf: Date
): ProgressWindow {
    if (!Number.isFinite(asOf.getTime())) {
        throw new Error('asOf must be a valid date');
    }
    if (scope === 'all') {
        return {
            scope,
            asOf: asOf.toISOString(),
            from: null,
            previousFrom: null,
            previousTo: null,
        };
    }
    const from = new Date(asOf.getTime() - scope * DAY_MS);
    return {
        scope,
        asOf: asOf.toISOString(),
        from: from.toISOString(),
        previousFrom: new Date(
            asOf.getTime() - scope * 2 * DAY_MS
        ).toISOString(),
        previousTo: from.toISOString(),
    };
}

export function inHalfOpenWindow(
    value: Date,
    from: Date | null,
    to: Date
) {
    const time = value.getTime();
    return (
        Number.isFinite(time) &&
        time < to.getTime() &&
        (from == null || time >= from.getTime())
    );
}

export function daysBetween(earlier: Date, later: Date) {
    return (later.getTime() - earlier.getTime()) / DAY_MS;
}

export function distributionsComparable(
    current: ReadonlyMap<string, number>,
    previous: ReadonlyMap<string, number>,
    tolerance = 0.15
) {
    const currentTotal = Array.from(current.values()).reduce(
        (sum, value) => sum + value,
        0
    );
    const previousTotal = Array.from(previous.values()).reduce(
        (sum, value) => sum + value,
        0
    );
    if (currentTotal === 0 || previousTotal === 0) return false;
    const keys = new Set([...current.keys(), ...previous.keys()]);
    return Array.from(keys).every((key) => {
        const currentShare = (current.get(key) ?? 0) / currentTotal;
        const previousShare = (previous.get(key) ?? 0) / previousTotal;
        return (
            Math.abs(currentShare - previousShare) <=
            tolerance + Number.EPSILON
        );
    });
}
