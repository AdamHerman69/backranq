import {
    PROGRESS_DEFINITION_VERSION,
    PROGRESS_PROVIDERS,
    PROGRESS_TIME_CLASSES,
    type ProgressAnalysisStateCounts,
    type ProgressBreakdownRow,
    type ProgressTierCounts,
    type ProgressRequest,
    type ProgressSnapshot,
} from '@/lib/progress/contracts';
import {
    distributionsComparable,
    progressRate,
    progressTrend,
    progressWindow,
} from '@/lib/progress/metrics';
import type {
    AttemptBreakdownSummary,
    CountMap,
    DistributionSummary,
    ProgressAttemptsSummary,
    ProgressGamesSummary,
    ProgressPositionsSummary,
} from '@/lib/progress/sqlRead';

const MIX_DIMENSIONS = [
    'provider',
    'timeClass',
    'source',
    'phase',
    'impact',
] as const;

function count(value: unknown, field: string) {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new Error(`Invalid Progress aggregate count: ${field}`);
    }
    return value;
}

function countFrom(map: CountMap, key: string, field: string) {
    return count(map[key] ?? 0, `${field}.${key}`);
}

function analysisStates(
    map: CountMap,
    field: string
): ProgressAnalysisStateCounts {
    return {
        imported: countFrom(map, 'imported', field),
        analyzed: countFrom(map, 'analyzed', field),
        stale: countFrom(map, 'stale', field),
        queued: countFrom(map, 'queued', field),
        running: countFrom(map, 'running', field),
        failed: countFrom(map, 'failed', field),
        waiting: countFrom(map, 'waiting', field),
    };
}

function tierCounts(map: CountMap, field: string): ProgressTierCounts {
    return {
        BEST: countFrom(map, 'BEST', field),
        STRONG: countFrom(map, 'STRONG', field),
        GOOD: countFrom(map, 'GOOD', field),
        SUBPAR: countFrom(map, 'SUBPAR', field),
    };
}

function distributionMap(rows: readonly DistributionSummary[]) {
    return new Map(
        rows.map((row) => [
            row.key,
            count(row.count, `distribution.${row.key}`),
        ])
    );
}

function distributionShares(rows: readonly DistributionSummary[]) {
    const ordered = rows
        .map((row) => ({
            key: row.key,
            count: count(row.count, `distribution.${row.key}`),
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
    const total = ordered.reduce((sum, row) => sum + row.count, 0);
    return ordered.map((row) => ({
        ...row,
        share: total > 0 ? row.count / total : 0,
    }));
}

function breakdownRows(args: {
    positionRows: ProgressPositionsSummary['breakdowns'][string] | undefined;
    attemptRows: AttemptBreakdownSummary[] | undefined;
}): ProgressBreakdownRow[] {
    const output = new Map<string, ProgressBreakdownRow>();
    for (const row of args.positionRows ?? []) {
        output.set(row.key, {
            key: row.key,
            positions: count(row.positions, `positions.${row.key}`),
            sourceGames: count(
                row.sourceGames,
                `sourceGames.${row.key}`
            ),
            resolvedAttempts: 0,
            fullPositionSolve: progressRate(0, 0),
        });
    }
    for (const row of args.attemptRows ?? []) {
        const resolved = count(
            row.resolvedAttempts,
            `resolvedAttempts.${row.key}`
        );
        const solved = count(
            row.solvedAttempts,
            `solvedAttempts.${row.key}`
        );
        const existing = output.get(row.key);
        output.set(row.key, {
            key: row.key,
            positions: existing?.positions ?? 0,
            sourceGames: existing?.sourceGames ?? 0,
            resolvedAttempts: resolved,
            fullPositionSolve: progressRate(solved, resolved),
        });
    }
    return Array.from(output.values()).sort((left, right) =>
        left.key.localeCompare(right.key)
    );
}

function primaryOperationalState(args: {
    linkedAccounts: { lichess: boolean; chesscom: boolean };
    allGames: number;
    states: ProgressAnalysisStateCounts;
    waitingForCredits: number;
}): ProgressSnapshot['operational']['primaryState'] {
    if (args.allGames === 0) {
        return args.linkedAccounts.lichess || args.linkedAccounts.chesscom
            ? 'NO_GAMES'
            : 'NO_LINKED_ACCOUNT';
    }
    if (args.waitingForCredits > 0) return 'WAITING_FOR_CREDITS';
    if (args.states.running > 0) return 'ANALYSIS_RUNNING';
    if (args.states.queued > 0) return 'ANALYSIS_QUEUED';
    if (args.states.analyzed === 0 && args.states.failed > 0) {
        return 'ANALYSIS_FAILED';
    }
    if (args.states.analyzed === 0) return 'NO_ANALYSIS';
    return 'READY';
}

export function assembleProgressSnapshot(args: {
    request: ProgressRequest;
    linkedAccounts: { lichess: boolean; chesscom: boolean };
    serverCreditsBalance: number | null;
    games: ProgressGamesSummary;
    positions: ProgressPositionsSummary;
    attempts: ProgressAttemptsSummary;
}): ProgressSnapshot {
    const currentStates = analysisStates(
        args.games.currentStates,
        'currentStates'
    );
    const previousStates = analysisStates(
        args.games.previousStates,
        'previousStates'
    );
    const operationalStates = analysisStates(
        args.games.operationalStates,
        'operationalStates'
    );
    const allGames = count(args.games.allGames, 'allGames');
    const currentEligiblePositions = count(
        args.positions.currentEligiblePositions,
        'currentEligiblePositions'
    );
    const currentEligibleGames = count(
        args.positions.currentEligibleGames,
        'currentEligibleGames'
    );
    const currentResolved = count(
        args.attempts.currentPractice.resolved,
        'currentPractice.resolved'
    );
    const currentSolved = count(
        args.attempts.currentPractice.solved,
        'currentPractice.solved'
    );
    const previousResolved = count(
        args.attempts.previousPractice.resolved,
        'previousPractice.resolved'
    );
    const previousSolved = count(
        args.attempts.previousPractice.solved,
        'previousPractice.solved'
    );
    const currentConfig = distributionMap(args.attempts.currentConfig);
    const previousConfig = distributionMap(args.attempts.previousConfig);
    const comparableConfig = distributionsComparable(
        currentConfig,
        previousConfig,
        0.15
    );
    const comparableMix = MIX_DIMENSIONS.every((dimension) =>
        distributionsComparable(
            distributionMap(args.attempts.currentMix[dimension] ?? []),
            distributionMap(args.attempts.previousMix[dimension] ?? []),
            0.15
        )
    );
    const waitingForCredits = count(
        args.serverCreditsBalance !== null &&
            args.serverCreditsBalance <= 0
            ? args.games.waitingForCredits.creditReasonOrWaiting
            : args.games.waitingForCredits.creditReason,
        'waitingForCredits'
    );
    const firstPositions = count(
        args.attempts.firstOutcome.positions,
        'firstOutcome.positions'
    );
    const firstResolved = count(
        args.attempts.firstOutcome.resolved,
        'firstOutcome.resolved'
    );
    const firstSolved = count(
        args.attempts.firstOutcome.solved,
        'firstOutcome.solved'
    );
    const delayedEligible = count(
        args.attempts.delayedRecheck.eligibleBaselines,
        'delayedRecheck.eligibleBaselines'
    );
    const delayedObserved = count(
        args.attempts.delayedRecheck.observedRechecks,
        'delayedRecheck.observedRechecks'
    );
    const delayedSolved = count(
        args.attempts.delayedRecheck.observedSolved,
        'delayedRecheck.observedSolved'
    );
    const filteredHistoricalGames = count(
        args.games.filteredHistoricalGames,
        'filteredHistoricalGames'
    );
    const filteredHistoricalAttempts = count(
        args.attempts.filteredHistoricalAttempts,
        'filteredHistoricalAttempts'
    );
    const filteredCurrentAttempts = count(
        args.attempts.filteredCurrentAttempts,
        'filteredCurrentAttempts'
    );
    const unfilteredCurrentAttempts = count(
        args.attempts.unfilteredCurrentAttempts,
        'unfilteredCurrentAttempts'
    );

    return {
        definitionVersion: PROGRESS_DEFINITION_VERSION,
        generatedAt: args.request.asOf.toISOString(),
        window: progressWindow(
            args.request.scope,
            args.request.asOf
        ),
        filters: args.request.filters,
        availability: {
            providers: PROGRESS_PROVIDERS.map((provider) => ({
                key: provider,
                sourceGames: countFrom(
                    args.games.currentByProvider,
                    provider,
                    'currentByProvider'
                ),
                terminalAttempts: countFrom(
                    args.attempts.currentByProvider,
                    provider,
                    'attempts.currentByProvider'
                ),
            })),
            timeClasses: PROGRESS_TIME_CLASSES.map((timeClass) => ({
                key: timeClass,
                sourceGames: countFrom(
                    args.games.currentByTimeClass,
                    timeClass,
                    'currentByTimeClass'
                ),
                terminalAttempts: countFrom(
                    args.attempts.currentByTimeClass,
                    timeClass,
                    'attempts.currentByTimeClass'
                ),
            })),
            hasDataOutsideScope:
                currentStates.imported === 0 &&
                filteredCurrentAttempts === 0 &&
                (filteredHistoricalGames > 0 ||
                    filteredHistoricalAttempts > 0),
            filteredEmpty:
                currentStates.imported === 0 &&
                filteredCurrentAttempts === 0 &&
                (Object.values(args.games.currentByProvider).reduce(
                    (sum, value) => sum + count(value, 'provider total'),
                    0
                ) > 0 ||
                    unfilteredCurrentAttempts > 0),
        },
        operational: {
            linkedAccounts: args.linkedAccounts,
            serverCreditsBalance: args.serverCreditsBalance,
            waitingForCredits,
            primaryState: primaryOperationalState({
                linkedAccounts: args.linkedAccounts,
                allGames,
                states: operationalStates,
                waitingForCredits,
            }),
        },
        coverage: {
            basis: 'SOURCE_GAME_PLAYED_AT',
            analysisStates: currentStates,
            analyzedRate: progressRate(
                currentStates.analyzed,
                currentStates.imported
            ),
            statesAreExclusive: true,
            strictValidity: {
                requiresCurrentRun: true,
                requiresSucceededRun: true,
                requiresCurrentPgnHash: true,
            },
            eligiblePositions: currentEligiblePositions,
            gamesWithEligiblePosition: progressRate(
                currentEligibleGames,
                currentStates.analyzed
            ),
            positionsPerAnalyzedGame: {
                positions: currentEligiblePositions,
                analyzedGames: currentStates.analyzed,
                average:
                    currentStates.analyzed > 0
                        ? currentEligiblePositions /
                          currentStates.analyzed
                        : null,
            },
        },
        firstRecordedTerminalOutcome: {
            basis: 'FIRST_RECORDED_RESOLVED_OR_REVEALED_PER_POSITION',
            positions: firstPositions,
            resolved: firstResolved,
            revealed: count(
                args.attempts.firstOutcome.revealed,
                'firstOutcome.revealed'
            ),
            metObjective: progressRate(firstSolved, firstPositions),
            resolvedFullSolve: progressRate(firstSolved, firstResolved),
            tierCounts: tierCounts(
                args.attempts.firstOutcome.tierCounts,
                'firstOutcome.tierCounts'
            ),
        },
        practice: {
            basis: 'TERMINAL_COMPLETED_AT',
            resolvedAttempts: currentResolved,
            revealedAttempts: count(
                args.attempts.currentPractice.revealed,
                'currentPractice.revealed'
            ),
            unavailableExcluded: count(
                args.attempts.currentPractice.unavailable,
                'currentPractice.unavailable'
            ),
            fullPositionSolve: progressRate(
                currentSolved,
                currentResolved
            ),
            rootDecisionSuccess: progressRate(
                count(
                    args.attempts.currentPractice.rootSolved,
                    'currentPractice.rootSolved'
                ),
                count(
                    args.attempts.currentPractice.rootObserved,
                    'currentPractice.rootObserved'
                )
            ),
            exactOriginalMoveRepeated: progressRate(
                count(
                    args.attempts.currentPractice.rootRepeated,
                    'currentPractice.rootRepeated'
                ),
                count(
                    args.attempts.currentPractice.rootObserved,
                    'currentPractice.rootObserved'
                )
            ),
            tierCounts: tierCounts(
                args.attempts.currentPractice.tierCounts,
                'currentPractice.tierCounts'
            ),
            fullPositionSolveTrend: progressTrend({
                current: progressRate(currentSolved, currentResolved),
                previous:
                    args.request.scope === 'all'
                        ? null
                        : progressRate(
                              previousSolved,
                              previousResolved
                          ),
                allTime: args.request.scope === 'all',
                comparableConfig,
                comparableCoverage: true,
                comparableMix,
            }),
        },
        inventory: {
            basis: 'CURRENT_ELIGIBLE_LIBRARY',
            eligiblePositions: count(
                args.positions.inventory.eligiblePositions,
                'inventory.eligiblePositions'
            ),
            fresh: count(args.positions.inventory.fresh, 'inventory.fresh'),
            needsAnotherLook: count(
                args.positions.inventory.needsAnotherLook,
                'inventory.needsAnotherLook'
            ),
            persistentOriginalMoveRepetition: count(
                args.positions.inventory
                    .persistentOriginalMoveRepetition,
                'inventory.persistentOriginalMoveRepetition'
            ),
        },
        actions: {
            disclosure:
                'ONLY_ALREADY_ATTEMPTED_POSITIONS_NO_PRE_ATTEMPT_THEME_CONTEXT',
            limitPerList: 20,
            needsAnotherLook: args.positions.actions.needsAnotherLook,
            persistentOriginalMoveRepetition:
                args.positions.actions
                    .persistentOriginalMoveRepetition,
        },
        delayedRecheck: {
            basis: 'FIRST_OBSERVED_RECHECK_7_TO_30_DAYS_AFTER_BASELINE',
            minimumDelayDays: 7,
            maximumDelayDays: 30,
            eligibleBaselines: delayedEligible,
            observedRechecks: delayedObserved,
            observationCoverage: progressRate(
                delayedObserved,
                delayedEligible
            ),
            observedFullSolve: progressRate(
                delayedSolved,
                delayedObserved
            ),
            disclosure:
                'UNOBSERVED_RECHECKS_ARE_NOT_COUNTED_AS_FAILURES',
        },
        impact: {
            winningChance: {
                low: countFrom(
                    args.positions.impact.winningChance,
                    'low',
                    'impact.winningChance'
                ),
                meaningful: countFrom(
                    args.positions.impact.winningChance,
                    'meaningful',
                    'impact.winningChance'
                ),
                major: countFrom(
                    args.positions.impact.winningChance,
                    'major',
                    'impact.winningChance'
                ),
            },
            centipawnFallback: {
                low: countFrom(
                    args.positions.impact.centipawnFallback,
                    'low',
                    'impact.centipawnFallback'
                ),
                meaningful: countFrom(
                    args.positions.impact.centipawnFallback,
                    'meaningful',
                    'impact.centipawnFallback'
                ),
                major: countFrom(
                    args.positions.impact.centipawnFallback,
                    'major',
                    'impact.centipawnFallback'
                ),
            },
            unknown: count(
                args.positions.impact.unknown,
                'impact.unknown'
            ),
            disclosure:
                'WIN_CHANCE_PRIMARY_CP_ONLY_WHEN_WIN_CHANCE_MISSING',
        },
        breakdowns: {
            phase: breakdownRows({
                positionRows: args.positions.breakdowns.phase,
                attemptRows: args.attempts.breakdowns.phase,
            }),
            impact: breakdownRows({
                positionRows: args.positions.breakdowns.impact,
                attemptRows: args.attempts.breakdowns.impact,
            }),
            provider: breakdownRows({
                positionRows: args.positions.breakdowns.provider,
                attemptRows: args.attempts.breakdowns.provider,
            }),
            timeClass: breakdownRows({
                positionRows: args.positions.breakdowns.timeClass,
                attemptRows: args.attempts.breakdowns.timeClass,
            }),
            source: breakdownRows({
                positionRows: args.positions.breakdowns.source,
                attemptRows: args.attempts.breakdowns.source,
            }),
            basis: {
                positionAndSourceGameCounts:
                    'CURRENT_LIBRARY_SOURCE_GAME_PLAYED_AT',
                resolvedAttemptCounts:
                    'TERMINAL_COMPLETED_AT_FROZEN_ATTEMPT_CONTEXT',
            },
            multiLabelDisclosure: {
                source: true,
                explanation:
                    'SOURCE_ROWS_OVERLAP_AND_MUST_NOT_BE_SUMMED',
            },
        },
        comparability: {
            currentConfigDistribution: distributionShares(
                args.attempts.currentConfig
            ),
            previousConfigDistribution: distributionShares(
                args.attempts.previousConfig
            ),
            comparableConfig,
            currentAnalysisCoverage: progressRate(
                currentStates.analyzed,
                currentStates.imported
            ),
            previousAnalysisCoverage:
                args.request.scope === 'all'
                    ? null
                    : progressRate(
                          previousStates.analyzed,
                          previousStates.imported
                      ),
            comparableMix,
            thresholds: {
                maximumCategoryShareDifference: 0.15,
            },
        },
        guardrails: {
            smallSample: {
                countsOnlyBelow: 10,
                earlySignalBelow: 50,
                confidence: 'WILSON_95',
            },
            trend: {
                minimumPerPeriod: 50,
                requiresComparableConfig: true,
                requiresComparableCoverage: false,
                requiresComparableMix: true,
                reportsConfidenceIntervalOfDifference: true,
            },
            exclusions: [
                'REVEALED_NOT_SOLVED',
                'UNAVAILABLE_NOT_WRONG',
                'PENDING_NOT_TERMINAL',
                'PENDING_NOT_RESOLVED',
            ],
        },
    };
}
