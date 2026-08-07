import {
    PROGRESS_DEFINITION_VERSION,
    type ProgressAnalysisStateCounts,
    type ProgressBreakdownRow,
    type ProgressFilters,
    type ProgressGradeCounts,
    type ProgressImpactBuckets,
    type ProgressPositionAction,
    type ProgressProvider,
    type ProgressRequest,
    type ProgressSnapshot,
    type ProgressTimeClass,
} from '@/lib/progress/contracts';
import {
    daysBetween,
    distributionsComparable,
    inHalfOpenWindow,
    progressRate,
    progressTrend,
    progressWindow,
} from '@/lib/progress/metrics';

type AnalysisRunStatus =
    | 'QUEUED'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED';
type AnalysisJobStatus = AnalysisRunStatus;
type AttemptStatus =
    | 'PENDING'
    | 'GRADED'
    | 'REVEALED'
    | 'SKIPPED'
    | 'UNRESOLVED';
type AttemptGrade = keyof ProgressGradeCounts;
type PositionPhase = 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';
type TrainingSourceKind = 'MY_MISTAKE' | 'MISSED_OPPORTUNITY';

export type ProgressUserRecord = {
    linkedAccounts: { lichess: boolean; chesscom: boolean };
    serverCreditsBalance: number | null;
};

export type ProgressGameRecord = {
    id: string;
    provider: ProgressProvider;
    timeClass: ProgressTimeClass;
    sourcePgnHash: string;
    playedAt: Date;
    analyzedAt: Date | null;
    currentAnalysisRunId: string | null;
    currentAnalysisValid: boolean;
    currentAnalysisRun: {
        id: string;
        status: AnalysisRunStatus;
        inputPgnHash: string;
        configHash: string;
    } | null;
    analysisJob: {
        status: AnalysisJobStatus;
        queuedReason: string | null;
    } | null;
};

export type ProgressAttemptRecord = {
    id: string;
    trainingMomentId: string;
    solutionRevisionId: string;
    attemptedAt: Date;
    completedAt: Date | null;
    userMoveUci: string | null;
    status: AttemptStatus;
    grade: AttemptGrade | null;
    contextPhase: PositionPhase | null;
    contextCpLoss: number | null;
    contextWinChanceLoss: number | null;
    contextSourceKinds: TrainingSourceKind[];
    contextProvider: ProgressProvider;
    contextTimeClass: ProgressTimeClass;
    contextConfigHash: string;
    contextSolutionHash: string;
    steps: Array<{
        stepIndex: number;
        actor: 'USER' | 'ENGINE';
        moveUci: string;
        grade: AttemptGrade | null;
    }>;
};

export type ProgressPositionRecord = {
    id: string;
    gameId: string;
    sourcePgnHash: string;
    originalMoveUci: string;
    cpLoss: number | null;
    winChanceLoss: number | null;
    phase: PositionPhase | null;
    status: 'ACTIVE' | 'UNSTABLE' | 'INVALIDATED' | 'ARCHIVED';
    sourceKinds: TrainingSourceKind[];
    currentSolutionRevisionId: string | null;
    archivedAt: Date | null;
    currentSolutionRevision: {
        id: string;
        solutionHash: string;
        configHash: string;
        verificationStatus:
            | 'VERIFIED'
            | 'AMBIGUOUS'
            | 'UNSTABLE'
            | 'INVALID';
        acceptanceFrontier: unknown;
        trainable: boolean;
    } | null;
    observations: Array<{
        analysisRunId: string;
        solutionRevisionId: string;
        observedSolutionHash: string;
    }>;
};

export type ProgressAggregationInput = {
    request: ProgressRequest;
    user: ProgressUserRecord;
    games: ProgressGameRecord[];
    positions: ProgressPositionRecord[];
    attempts: ProgressAttemptRecord[];
};

type GameState =
    | 'analyzed'
    | 'stale'
    | 'queued'
    | 'running'
    | 'failed'
    | 'waiting';

type EligiblePosition = {
    position: ProgressPositionRecord;
    game: ProgressGameRecord;
};

const ACTION_LIMIT = 20;
const MIX_TOLERANCE = 0.15;

function emptyGradeCounts(): ProgressGradeCounts {
    return {
        BEST: 0,
        STRONG: 0,
        GOOD: 0,
        IMPROVED: 0,
        REPEATED_MISTAKE: 0,
        DIFFERENT_MISTAKE: 0,
    };
}

function isFullSolve(grade: AttemptGrade | null) {
    return (
        grade === 'BEST' ||
        grade === 'STRONG' ||
        grade === 'GOOD'
    );
}

function matchesFilters(
    game: ProgressGameRecord,
    filters: ProgressFilters
) {
    return (
        (filters.providers.length === 0 ||
            filters.providers.includes(game.provider)) &&
        (filters.timeClasses.length === 0 ||
            filters.timeClasses.includes(game.timeClass))
    );
}

function strictAnalysisIsValid(game: ProgressGameRecord) {
    const run = game.currentAnalysisRun;
    return Boolean(
        game.currentAnalysisRunId &&
            game.currentAnalysisValid &&
            run &&
            run.id === game.currentAnalysisRunId &&
            run.status === 'SUCCEEDED' &&
            run.inputPgnHash === game.sourcePgnHash
    );
}

function gameState(game: ProgressGameRecord): GameState {
    if (strictAnalysisIsValid(game)) return 'analyzed';
    if (
        game.analysisJob?.status === 'RUNNING' ||
        game.currentAnalysisRun?.status === 'RUNNING'
    ) {
        return 'running';
    }
    if (
        game.analysisJob?.status === 'QUEUED' ||
        game.currentAnalysisRun?.status === 'QUEUED'
    ) {
        return 'queued';
    }
    if (
        game.analysisJob?.status === 'FAILED' ||
        game.currentAnalysisRun?.status === 'FAILED'
    ) {
        return 'failed';
    }
    if (
        game.currentAnalysisRunId ||
        game.currentAnalysisRun ||
        game.analyzedAt
    ) {
        return 'stale';
    }
    return 'waiting';
}

function analysisCounts(games: readonly ProgressGameRecord[]) {
    const counts: ProgressAnalysisStateCounts = {
        imported: games.length,
        analyzed: 0,
        stale: 0,
        queued: 0,
        running: 0,
        failed: 0,
        waiting: 0,
    };
    for (const game of games) counts[gameState(game)] += 1;
    return counts;
}

function positionIsEligible(
    position: ProgressPositionRecord,
    game: ProgressGameRecord
) {
    const revision = position.currentSolutionRevision;
    const run = game.currentAnalysisRun;
    if (
        !strictAnalysisIsValid(game) ||
        !run ||
        position.status !== 'ACTIVE' ||
        position.archivedAt !== null ||
        position.sourcePgnHash !== run.inputPgnHash ||
        !position.currentSolutionRevisionId ||
        !revision ||
        revision.id !== position.currentSolutionRevisionId ||
        !revision.trainable ||
        revision.verificationStatus !== 'VERIFIED' ||
        !hasStableAcceptanceFrontier(revision.acceptanceFrontier)
    ) {
        return false;
    }
    return position.observations.some(
        (observation) =>
            observation.analysisRunId === run.id &&
            observation.solutionRevisionId === revision.id &&
            observation.observedSolutionHash === revision.solutionHash
    );
}

function hasStableAcceptanceFrontier(value: unknown) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'status' in value &&
        value.status === 'STABLE'
    );
}

function sortedTerminalAttempts(
    attempts: readonly ProgressAttemptRecord[],
    asOf: Date
) {
    return attempts
        .filter(
            (attempt) =>
                attempt.completedAt !== null &&
                attempt.completedAt.getTime() <= asOf.getTime() &&
                (attempt.status === 'GRADED' ||
                    attempt.status === 'REVEALED')
        )
        .slice()
        .sort((left, right) => {
            const time =
                left.completedAt!.getTime() -
                right.completedAt!.getTime();
            return time !== 0 ? time : left.id.localeCompare(right.id);
        });
}

function attemptSolutionHash(attempt: ProgressAttemptRecord) {
    return attempt.contextSolutionHash;
}

function attemptConfigHash(attempt: ProgressAttemptRecord) {
    return attempt.contextConfigHash;
}

function currentSemanticTerminalAttempts(
    position: ProgressPositionRecord,
    attempts: readonly ProgressAttemptRecord[],
    asOf: Date
) {
    const revision = position.currentSolutionRevision;
    if (!revision) return [];
    return sortedTerminalAttempts(attempts, asOf).filter(
        (attempt) =>
            attemptSolutionHash(attempt) === revision.solutionHash &&
            attemptConfigHash(attempt) === revision.configHash
    );
}

function rootStep(attempt: ProgressAttemptRecord) {
    return attempt.steps
        .filter((step) => step.actor === 'USER')
        .slice()
        .sort((left, right) => left.stepIndex - right.stepIndex)[0];
}

function exactOriginalMoveRepeated(
    attempt: ProgressAttemptRecord
) {
    return rootStep(attempt)?.grade === 'REPEATED_MISTAKE';
}

function hasPersistentOriginalMoveRepetition(
    attempts: readonly ProgressAttemptRecord[]
) {
    const repeated = attempts.filter(
        (attempt) =>
            attempt.completedAt !== null &&
            exactOriginalMoveRepeated(attempt)
    );
    if (repeated.length < 2) return false;
    return daysBetween(
        repeated[0].completedAt!,
        repeated.at(-1)!.completedAt!
    ) >= 1;
}

function impactForValues(
    winChanceLoss: number | null,
    cpLoss: number | null
) {
    if (
        typeof winChanceLoss === 'number' &&
        Number.isFinite(winChanceLoss) &&
        winChanceLoss >= 0
    ) {
        return {
            basis: 'WIN_CHANCE' as const,
            bucket:
                winChanceLoss >= 0.12
                    ? ('MAJOR' as const)
                    : winChanceLoss >= 0.08
                      ? ('MEANINGFUL' as const)
                      : ('LOW' as const),
        };
    }
    if (
        typeof cpLoss === 'number' &&
        Number.isFinite(cpLoss) &&
        cpLoss >= 0
    ) {
        return {
            basis: 'CENTIPAWN_FALLBACK' as const,
            bucket:
                cpLoss >= 150
                    ? ('MAJOR' as const)
                    : cpLoss >= 100
                      ? ('MEANINGFUL' as const)
                      : ('LOW' as const),
        };
    }
    return {
        basis: 'UNKNOWN' as const,
        bucket: 'UNKNOWN' as const,
    };
}

function impactFor(position: ProgressPositionRecord) {
    return impactForValues(
        position.winChanceLoss,
        position.cpLoss
    );
}

function impactForAttempt(
    attempt: ProgressAttemptRecord
) {
    return impactForValues(
        attempt.contextWinChanceLoss,
        attempt.contextCpLoss
    );
}

function impactKey(
    impact: ReturnType<typeof impactForValues>
) {
    return impact.basis === 'UNKNOWN'
        ? 'UNKNOWN'
        : `${impact.basis}_${impact.bucket}`;
}

function impactBuckets(
    positions: readonly EligiblePosition[]
): ProgressImpactBuckets {
    const output: ProgressImpactBuckets = {
        winningChance: { low: 0, meaningful: 0, major: 0 },
        centipawnFallback: { low: 0, meaningful: 0, major: 0 },
        unknown: 0,
        disclosure:
            'WIN_CHANCE_PRIMARY_CP_ONLY_WHEN_WIN_CHANCE_MISSING',
    };
    for (const { position } of positions) {
        const impact = impactFor(position);
        if (impact.basis === 'UNKNOWN') {
            output.unknown += 1;
            continue;
        }
        const key = impact.bucket.toLowerCase() as
            | 'low'
            | 'meaningful'
            | 'major';
        if (impact.basis === 'WIN_CHANCE') {
            output.winningChance[key] += 1;
        } else {
            output.centipawnFallback[key] += 1;
        }
    }
    return output;
}

function datesForWindow(request: ProgressRequest) {
    const window = progressWindow(request.scope, request.asOf);
    return {
        window,
        from: window.from ? new Date(window.from) : null,
        previousFrom: window.previousFrom
            ? new Date(window.previousFrom)
            : null,
        previousTo: window.previousTo
            ? new Date(window.previousTo)
            : null,
    };
}

function attemptsInWindow(
    attempts: readonly ProgressAttemptRecord[],
    filters: ProgressFilters,
    from: Date | null,
    to: Date
) {
    return attempts
        .filter(
            (attempt) =>
                attempt.completedAt !== null &&
                inHalfOpenWindow(attempt.completedAt, from, to) &&
                (filters.providers.length === 0 ||
                    filters.providers.includes(
                        attempt.contextProvider
                    )) &&
                (filters.timeClasses.length === 0 ||
                    filters.timeClasses.includes(
                        attempt.contextTimeClass
                    ))
        )
        .map((attempt) => ({ attempt }));
}

function practicePeriod(
    attempts: ReturnType<typeof attemptsInWindow>
) {
    const graded = attempts.filter(
        ({ attempt }) =>
            attempt.status === 'GRADED' && attempt.grade !== null
    );
    const revealed = attempts.filter(
        ({ attempt }) => attempt.status === 'REVEALED'
    );
    const unresolved = attempts.filter(
        ({ attempt }) => attempt.status === 'UNRESOLVED'
    );
    const gradeCounts = emptyGradeCounts();
    for (const { attempt } of graded) {
        gradeCounts[attempt.grade!] += 1;
    }
    const fullSolved = graded.filter(({ attempt }) =>
        isFullSolve(attempt.grade)
    ).length;
    const withRoot = graded.filter(
        ({ attempt }) => rootStep(attempt)?.grade != null
    );
    const rootSolved = withRoot.filter(({ attempt }) =>
        isFullSolve(rootStep(attempt)?.grade ?? null)
    ).length;
    const exactRepeated = withRoot.filter(({ attempt }) =>
        exactOriginalMoveRepeated(attempt)
    ).length;
    return {
        graded,
        revealed,
        unresolved,
        gradeCounts,
        fullPositionSolve: progressRate(fullSolved, graded.length),
        rootDecisionSuccess: progressRate(rootSolved, withRoot.length),
        exactOriginalMoveRepeated: progressRate(
            exactRepeated,
            withRoot.length
        ),
    };
}

function firstOutcomes(
    attemptsByPosition: ReadonlyMap<
        string,
        readonly ProgressAttemptRecord[]
    >,
    from: Date | null,
    to: Date
) {
    const first = Array.from(attemptsByPosition.values())
        .map((attempts) => sortedTerminalAttempts(attempts, to)[0])
        .filter(
            (attempt): attempt is ProgressAttemptRecord =>
                Boolean(
                    attempt?.completedAt &&
                        inHalfOpenWindow(attempt.completedAt, from, to)
                )
        );
    const graded = first.filter(
        (attempt) =>
            attempt.status === 'GRADED' && attempt.grade !== null
    );
    const acceptedFirst = graded.filter((attempt) =>
        isFullSolve(attempt.grade)
    ).length;
    const gradeCounts = emptyGradeCounts();
    for (const attempt of graded) gradeCounts[attempt.grade!] += 1;
    return {
        basis:
            'FIRST_RECORDED_GRADED_OR_REVEALED_PER_POSITION' as const,
        positions: first.length,
        graded: graded.length,
        revealed: first.filter(
            (attempt) => attempt.status === 'REVEALED'
        ).length,
        metObjective: progressRate(acceptedFirst, first.length),
        gradedFullSolve: progressRate(
            acceptedFirst,
            graded.length
        ),
        gradeCounts,
    };
}

function actionReason(
    position: ProgressPositionRecord,
    terminal: ProgressAttemptRecord[]
): ProgressPositionAction['reason'] | null {
    const latest = terminal.at(-1);
    if (!latest) return null;
    if (
        latest.status === 'GRADED' &&
        exactOriginalMoveRepeated(latest)
    ) {
        return 'LATEST_ORIGINAL_MOVE_REPEATED';
    }
    const latestRevealIndex = terminal.findLastIndex(
        (attempt) => attempt.status === 'REVEALED'
    );
    if (latestRevealIndex >= 0) {
        const laterSolve = terminal
            .slice(latestRevealIndex + 1)
            .some(
                (attempt) =>
                    attempt.status === 'GRADED' &&
                    isFullSolve(attempt.grade)
            );
        if (!laterSolve && latest.status === 'REVEALED') {
            return 'REVEALED_WITHOUT_LATER_SOLVE';
        }
    }
    if (
        latest.status === 'GRADED' &&
        !isFullSolve(latest.grade)
    ) {
        return hasPersistentOriginalMoveRepetition(terminal)
            ? 'PERSISTENT_ORIGINAL_MOVE_REPETITION'
            : 'LATEST_FULL_POSITION_NOT_SOLVED';
    }
    return null;
}

function actionSort(
    left: ProgressPositionAction,
    right: ProgressPositionAction
) {
    const reasonRank: Record<ProgressPositionAction['reason'], number> = {
        LATEST_ORIGINAL_MOVE_REPEATED: 0,
        PERSISTENT_ORIGINAL_MOVE_REPETITION: 1,
        LATEST_FULL_POSITION_NOT_SOLVED: 2,
        REVEALED_WITHOUT_LATER_SOLVE: 3,
    };
    const impactRank: Record<
        ProgressPositionAction['impact']['bucket'],
        number
    > = {
        MAJOR: 0,
        MEANINGFUL: 1,
        LOW: 2,
        UNKNOWN: 3,
    };
    return (
        reasonRank[left.reason] - reasonRank[right.reason] ||
        impactRank[left.impact.bucket] -
            impactRank[right.impact.bucket] ||
        right.daysSinceLatestTerminal -
            left.daysSinceLatestTerminal ||
        left.positionId.localeCompare(right.positionId)
    );
}

function inventoryAndActions(
    positions: readonly EligiblePosition[],
    attemptsByPosition: ReadonlyMap<
        string,
        readonly ProgressAttemptRecord[]
    >,
    asOf: Date
) {
    let fresh = 0;
    let persistent = 0;
    const actions: ProgressPositionAction[] = [];
    const persistentIds = new Set<string>();
    for (const { position, game } of positions) {
        const terminal = currentSemanticTerminalAttempts(
            position,
            attemptsByPosition.get(position.id) ?? [],
            asOf
        );
        if (terminal.length === 0) {
            fresh += 1;
            continue;
        }
        const repeated = terminal.filter(
            (attempt) =>
                attempt.status === 'GRADED' &&
                exactOriginalMoveRepeated(attempt)
        ).length;
        const reason = actionReason(position, terminal);
        if (!reason) continue;
        const isPersistent =
            hasPersistentOriginalMoveRepetition(terminal);
        if (isPersistent) {
            persistent += 1;
            persistentIds.add(position.id);
        }
        const latest = terminal.at(-1)!;
        actions.push({
            positionId: position.id,
            sourceGameId: position.gameId,
            reason,
            latestTerminalAt: latest.completedAt!.toISOString(),
            latestGrade:
                latest.status === 'REVEALED'
                    ? 'REVEALED'
                    : latest.grade!,
            exactOriginalMoveRepeatCount: repeated,
            impact: impactFor(position),
            phase: position.phase ?? 'UNKNOWN',
            provider: game.provider,
            timeClass: game.timeClass,
            daysSinceLatestTerminal: Math.max(
                0,
                Math.floor(
                    daysBetween(latest.completedAt!, asOf)
                )
            ),
        });
    }
    actions.sort(actionSort);
    const persistentActions = actions
        .filter((action) =>
            persistentIds.has(action.positionId)
        )
        .slice(0, ACTION_LIMIT);
    return {
        inventory: {
            basis: 'CURRENT_ELIGIBLE_LIBRARY' as const,
            eligiblePositions: positions.length,
            fresh,
            needsAnotherLook: actions.length,
            persistentOriginalMoveRepetition: persistent,
        },
        actions: {
            disclosure:
                'ONLY_ALREADY_ATTEMPTED_POSITIONS_NO_PRE_ATTEMPT_THEME_CONTEXT' as const,
            limitPerList: ACTION_LIMIT as 20,
            needsAnotherLook: actions.slice(0, ACTION_LIMIT),
            persistentOriginalMoveRepetition: persistentActions,
        },
    };
}

function delayedRecheck(
    attemptsByPosition: ReadonlyMap<
        string,
        readonly ProgressAttemptRecord[]
    >,
    asOf: Date
) {
    let eligibleBaselines = 0;
    let observedRechecks = 0;
    let observedSolved = 0;
    for (const attempts of attemptsByPosition.values()) {
        const terminal = sortedTerminalAttempts(attempts, asOf);
        const baseline = terminal.find(
            (attempt) =>
                attempt.status === 'GRADED' &&
                isFullSolve(attempt.grade)
        );
        if (
            !baseline?.completedAt ||
            daysBetween(baseline.completedAt, asOf) < 7
        ) {
            continue;
        }
        const baselineIndex = terminal.findIndex(
            (attempt) => attempt.id === baseline.id
        );
        const recheck = terminal
            .slice(baselineIndex + 1)
            .find(
                (attempt) =>
                    attemptSolutionHash(attempt) ===
                        attemptSolutionHash(baseline) &&
                    attemptConfigHash(attempt) ===
                        attemptConfigHash(baseline)
            );
        const delay = recheck?.completedAt
            ? daysBetween(
                  baseline.completedAt,
                  recheck.completedAt
              )
            : null;
        // A same-semantics attempt before day 7 contaminates the delayed
        // cohort. Never skip over it to cherry-pick a later attempt.
        if (delay !== null && delay < 7) continue;
        eligibleBaselines += 1;
        if (delay === null || delay > 30) continue;
        if (!recheck) continue;
        observedRechecks += 1;
        if (
            recheck.status === 'GRADED' &&
            isFullSolve(recheck.grade)
        ) {
            observedSolved += 1;
        }
    }
    return {
        basis:
            'FIRST_OBSERVED_RECHECK_7_TO_30_DAYS_AFTER_BASELINE' as const,
        minimumDelayDays: 7 as const,
        maximumDelayDays: 30 as const,
        eligibleBaselines,
        observedRechecks,
        observationCoverage: progressRate(
            observedRechecks,
            eligibleBaselines
        ),
        observedFullSolve: progressRate(
            observedSolved,
            observedRechecks
        ),
        disclosure:
            'UNOBSERVED_RECHECKS_ARE_NOT_COUNTED_AS_FAILURES' as const,
    };
}

function addCount(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function mixDistributions(
    attempts: ReturnType<typeof attemptsInWindow>
) {
    const dimensions = {
        provider: new Map<string, number>(),
        timeClass: new Map<string, number>(),
        source: new Map<string, number>(),
        phase: new Map<string, number>(),
        impact: new Map<string, number>(),
    };
    for (const { attempt } of attempts) {
        if (attempt.status !== 'GRADED') continue;
        const source = attempt.contextSourceKinds
            .slice()
            .sort()
            .join('+') || 'UNKNOWN';
        addCount(dimensions.provider, attempt.contextProvider);
        addCount(dimensions.timeClass, attempt.contextTimeClass);
        addCount(dimensions.source, source);
        addCount(
            dimensions.phase,
            attempt.contextPhase ?? 'UNKNOWN'
        );
        addCount(
            dimensions.impact,
            impactKey(impactForAttempt(attempt))
        );
    }
    return dimensions;
}

function configDistribution(
    attempts: ReturnType<typeof attemptsInWindow>
) {
    const distribution = new Map<string, number>();
    for (const { attempt } of attempts) {
        if (attempt.status === 'GRADED') {
            addCount(distribution, attempt.contextConfigHash);
        }
    }
    return distribution;
}

function distributionShares(distribution: ReadonlyMap<string, number>) {
    const total = Array.from(distribution.values()).reduce(
        (sum, count) => sum + count,
        0
    );
    return Array.from(distribution.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => ({
            key,
            count,
            share: total > 0 ? count / total : 0,
        }));
}

function breakdownRows(
    eligible: readonly EligiblePosition[],
    attempts: ReturnType<typeof attemptsInWindow>,
    positionKeys: (entry: EligiblePosition) => string[],
    attemptKeys: (
        entry: ReturnType<typeof attemptsInWindow>[number]
    ) => string[]
): ProgressBreakdownRow[] {
    const positionSets = new Map<string, Set<string>>();
    const gameSets = new Map<string, Set<string>>();
    const gradedCounts = new Map<string, number>();
    const solvedCounts = new Map<string, number>();
    for (const entry of eligible) {
        for (const key of positionKeys(entry)) {
            const positions =
                positionSets.get(key) ?? new Set<string>();
            positions.add(entry.position.id);
            positionSets.set(key, positions);
            const games = gameSets.get(key) ?? new Set<string>();
            games.add(entry.game.id);
            gameSets.set(key, games);
        }
    }
    for (const item of attempts) {
        if (item.attempt.status !== 'GRADED') continue;
        for (const key of attemptKeys(item)) {
            addCount(gradedCounts, key);
            if (isFullSolve(item.attempt.grade)) {
                addCount(solvedCounts, key);
            }
        }
    }
    return Array.from(
        new Set([
            ...positionSets.keys(),
            ...gradedCounts.keys(),
        ])
    )
        .sort()
        .map((key) => ({
            key,
            positions: positionSets.get(key)?.size ?? 0,
            sourceGames: gameSets.get(key)?.size ?? 0,
            gradedAttempts: gradedCounts.get(key) ?? 0,
            fullPositionSolve: progressRate(
                solvedCounts.get(key) ?? 0,
                gradedCounts.get(key) ?? 0
            ),
        }));
}

function waitingForCredits(
    games: readonly ProgressGameRecord[],
    balance: number | null
) {
    return games.filter((game) => {
        if (strictAnalysisIsValid(game)) return false;
        if (
            game.analysisJob?.queuedReason
                ?.toLowerCase()
                .includes('credit')
        ) {
            return true;
        }
        return balance !== null && balance <= 0 && gameState(game) === 'waiting';
    }).length;
}

function primaryOperationalState(args: {
    user: ProgressUserRecord;
    games: readonly ProgressGameRecord[];
    counts: ProgressAnalysisStateCounts;
    waitingCredits: number;
}) {
    if (args.games.length === 0) {
        if (!args.user.linkedAccounts.lichess && !args.user.linkedAccounts.chesscom) {
            return 'NO_LINKED_ACCOUNT' as const;
        }
        return 'NO_GAMES' as const;
    }
    if (args.waitingCredits > 0) {
        return 'WAITING_FOR_CREDITS' as const;
    }
    if (args.counts.running > 0) return 'ANALYSIS_RUNNING' as const;
    if (args.counts.queued > 0) return 'ANALYSIS_QUEUED' as const;
    if (args.counts.analyzed === 0 && args.counts.failed > 0) {
        return 'ANALYSIS_FAILED' as const;
    }
    if (args.counts.analyzed === 0) return 'NO_ANALYSIS' as const;
    return 'READY' as const;
}

export function aggregateProgressSnapshot({
    request,
    user,
    games,
    positions,
    attempts,
}: ProgressAggregationInput): ProgressSnapshot {
    const { window, from, previousFrom, previousTo } =
        datesForWindow(request);
    const gameById = new Map(games.map((game) => [game.id, game]));
    const allGamesAsOf = games.filter(
        (game) =>
            game.playedAt.getTime() <= request.asOf.getTime()
    );
    const filteredAllGames = allGamesAsOf.filter((game) =>
        matchesFilters(game, request.filters)
    );
    const currentGames = filteredAllGames.filter((game) =>
        inHalfOpenWindow(game.playedAt, from, request.asOf)
    );
    const previousGames =
        previousFrom && previousTo
            ? filteredAllGames.filter((game) =>
                  inHalfOpenWindow(
                      game.playedAt,
                      previousFrom,
                      previousTo
                  )
              )
            : [];
    const currentCounts = analysisCounts(currentGames);
    const previousCounts = analysisCounts(previousGames);
    const eligibleAll = positions.flatMap((position) => {
        const game = gameById.get(position.gameId);
        return game &&
            matchesFilters(game, request.filters) &&
            game.playedAt.getTime() <= request.asOf.getTime() &&
            positionIsEligible(position, game)
            ? [{ position, game }]
            : [];
    });
    const eligibleCurrent = eligibleAll.filter(({ game }) =>
        inHalfOpenWindow(game.playedAt, from, request.asOf)
    );
    const filteredAttempts = attempts.filter(
        (attempt) =>
            attempt.completedAt !== null &&
            attempt.completedAt.getTime() <=
                request.asOf.getTime() &&
            (request.filters.providers.length === 0 ||
                request.filters.providers.includes(
                    attempt.contextProvider
                )) &&
            (request.filters.timeClasses.length === 0 ||
                request.filters.timeClasses.includes(
                    attempt.contextTimeClass
                ))
    );
    const allAttemptsByPosition = new Map<
        string,
        ProgressAttemptRecord[]
    >();
    for (const attempt of attempts) {
        if (
            attempt.completedAt === null ||
            attempt.completedAt.getTime() >
                request.asOf.getTime()
        ) {
            continue;
        }
        const grouped =
            allAttemptsByPosition.get(attempt.trainingMomentId) ??
            [];
        grouped.push(attempt);
        allAttemptsByPosition.set(
            attempt.trainingMomentId,
            grouped
        );
    }
    const filteredAttemptsByPosition = new Map<
        string,
        ProgressAttemptRecord[]
    >();
    for (const attempt of filteredAttempts) {
        const grouped =
            filteredAttemptsByPosition.get(
                attempt.trainingMomentId
            ) ?? [];
        grouped.push(attempt);
        filteredAttemptsByPosition.set(
            attempt.trainingMomentId,
            grouped
        );
    }
    const currentAttempts = attemptsInWindow(
        filteredAttempts,
        request.filters,
        from,
        request.asOf
    );
    const previousAttempts =
        previousFrom && previousTo
            ? attemptsInWindow(
                  filteredAttempts,
                  request.filters,
                  previousFrom,
                  previousTo
              )
            : [];
    const currentPractice = practicePeriod(currentAttempts);
    const previousPractice = practicePeriod(previousAttempts);
    const currentConfig = configDistribution(currentAttempts);
    const previousConfig = configDistribution(previousAttempts);
    const comparableConfig = distributionsComparable(
        currentConfig,
        previousConfig,
        MIX_TOLERANCE
    );
    const currentMix = mixDistributions(currentAttempts);
    const previousMix = mixDistributions(previousAttempts);
    const comparableMix = (
        Object.keys(currentMix) as Array<keyof typeof currentMix>
    ).every((dimension) =>
        distributionsComparable(
            currentMix[dimension],
            previousMix[dimension],
            MIX_TOLERANCE
        )
    );
    const gameIdsWithPosition = new Set(
        eligibleCurrent.map(({ game }) => game.id)
    );
    const inventory = inventoryAndActions(
        eligibleAll,
        allAttemptsByPosition,
        request.asOf
    );

    const unfilteredCurrent = allGamesAsOf.filter(
        (game) =>
            inHalfOpenWindow(game.playedAt, from, request.asOf)
    );
    const unfilteredCurrentAttempts = attemptsInWindow(
        attempts,
        { providers: [], timeClasses: [] },
        from,
        request.asOf
    );
    const providerOptions = (
        ['LICHESS', 'CHESSCOM', 'MANUAL_PGN', 'BACKRANQ_COACH'] as const
    ).map((provider) => ({
        key: provider,
        sourceGames: unfilteredCurrent.filter(
            (game) => game.provider === provider
        ).length,
        terminalAttempts: unfilteredCurrentAttempts.filter(
            ({ attempt }) =>
                attempt.contextProvider === provider
        ).length,
    }));
    const timeClassOptions = (
        [
            'BULLET',
            'BLITZ',
            'RAPID',
            'CLASSICAL',
            'UNKNOWN',
        ] as const
    ).map((timeClass) => ({
        key: timeClass,
        sourceGames: unfilteredCurrent.filter(
            (game) => game.timeClass === timeClass
        ).length,
        terminalAttempts: unfilteredCurrentAttempts.filter(
            ({ attempt }) =>
                attempt.contextTimeClass === timeClass
        ).length,
    }));
    const waitingCredits = waitingForCredits(
        allGamesAsOf,
        user.serverCreditsBalance
    );

    return {
        definitionVersion: PROGRESS_DEFINITION_VERSION,
        generatedAt: request.asOf.toISOString(),
        window,
        filters: request.filters,
        availability: {
            providers: providerOptions,
            timeClasses: timeClassOptions,
            hasDataOutsideScope:
                currentGames.length === 0 &&
                currentAttempts.length === 0 &&
                (filteredAllGames.length > 0 ||
                    filteredAttempts.length > 0),
            filteredEmpty:
                currentGames.length === 0 &&
                currentAttempts.length === 0 &&
                (unfilteredCurrent.length > 0 ||
                    unfilteredCurrentAttempts.length > 0),
        },
        operational: {
            linkedAccounts: user.linkedAccounts,
            serverCreditsBalance: user.serverCreditsBalance,
            waitingForCredits: waitingCredits,
            primaryState: primaryOperationalState({
                user,
                games: allGamesAsOf,
                counts: analysisCounts(allGamesAsOf),
                waitingCredits,
            }),
        },
        coverage: {
            basis: 'SOURCE_GAME_PLAYED_AT',
            analysisStates: currentCounts,
            analyzedRate: progressRate(
                currentCounts.analyzed,
                currentCounts.imported
            ),
            statesAreExclusive: true,
            strictValidity: {
                requiresCurrentRun: true,
                requiresSucceededRun: true,
                requiresCurrentPgnHash: true,
            },
            eligiblePositions: eligibleCurrent.length,
            gamesWithEligiblePosition: progressRate(
                gameIdsWithPosition.size,
                currentCounts.analyzed
            ),
            positionsPerAnalyzedGame: {
                positions: eligibleCurrent.length,
                analyzedGames: currentCounts.analyzed,
                average:
                    currentCounts.analyzed > 0
                        ? eligibleCurrent.length /
                          currentCounts.analyzed
                        : null,
            },
        },
        firstRecordedTerminalOutcome: firstOutcomes(
            filteredAttemptsByPosition,
            from,
            request.asOf
        ),
        practice: {
            basis: 'TERMINAL_COMPLETED_AT',
            gradedAttempts: currentPractice.graded.length,
            revealedAttempts: currentPractice.revealed.length,
            unresolvedExcluded: currentPractice.unresolved.length,
            fullPositionSolve:
                currentPractice.fullPositionSolve,
            rootDecisionSuccess:
                currentPractice.rootDecisionSuccess,
            exactOriginalMoveRepeated:
                currentPractice.exactOriginalMoveRepeated,
            gradeCounts: currentPractice.gradeCounts,
            fullPositionSolveTrend: progressTrend({
                current: currentPractice.fullPositionSolve,
                previous:
                    request.scope === 'all'
                        ? null
                        : previousPractice.fullPositionSolve,
                allTime: request.scope === 'all',
                comparableConfig,
                // Game-analysis coverage describes current inventory, not
                // the frozen historical Practice cohort.
                comparableCoverage: true,
                comparableMix,
            }),
        },
        inventory: inventory.inventory,
        actions: inventory.actions,
        delayedRecheck: delayedRecheck(
            filteredAttemptsByPosition,
            request.asOf
        ),
        impact: impactBuckets(eligibleCurrent),
        breakdowns: {
            phase: breakdownRows(
                eligibleCurrent,
                currentAttempts,
                ({ position }) => [
                    position.phase ?? 'UNKNOWN',
                ],
                ({ attempt }) => [
                    attempt.contextPhase ?? 'UNKNOWN',
                ]
            ),
            impact: breakdownRows(
                eligibleCurrent,
                currentAttempts,
                ({ position }) => [
                    impactKey(impactFor(position)),
                ],
                ({ attempt }) => [
                    impactKey(impactForAttempt(attempt)),
                ]
            ),
            provider: breakdownRows(
                eligibleCurrent,
                currentAttempts,
                ({ game }) => [game.provider],
                ({ attempt }) => [attempt.contextProvider]
            ),
            timeClass: breakdownRows(
                eligibleCurrent,
                currentAttempts,
                ({ game }) => [game.timeClass],
                ({ attempt }) => [attempt.contextTimeClass]
            ),
            source: breakdownRows(
                eligibleCurrent,
                currentAttempts,
                ({ position }) =>
                    position.sourceKinds.length > 0
                        ? position.sourceKinds
                        : ['UNKNOWN'],
                ({ attempt }) => {
                    return attempt.contextSourceKinds.length > 0
                        ? attempt.contextSourceKinds
                        : ['UNKNOWN'];
                }
            ),
            basis: {
                positionAndSourceGameCounts:
                    'CURRENT_LIBRARY_SOURCE_GAME_PLAYED_AT',
                gradedAttemptCounts:
                    'TERMINAL_COMPLETED_AT_FROZEN_ATTEMPT_CONTEXT',
            },
            multiLabelDisclosure: {
                source: true,
                explanation:
                    'SOURCE_ROWS_OVERLAP_AND_MUST_NOT_BE_SUMMED',
            },
        },
        comparability: {
            currentConfigDistribution:
                distributionShares(currentConfig),
            previousConfigDistribution:
                distributionShares(previousConfig),
            comparableConfig,
            currentAnalysisCoverage: progressRate(
                currentCounts.analyzed,
                currentCounts.imported
            ),
            previousAnalysisCoverage:
                request.scope === 'all'
                    ? null
                    : progressRate(
                          previousCounts.analyzed,
                          previousCounts.imported
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
                'UNRESOLVED_NOT_WRONG',
                'PENDING_NOT_TERMINAL',
                'SKIPPED_NOT_GRADED',
            ],
        },
    };
}
