export const PROGRESS_DEFINITION_VERSION = 'progress-v1' as const;

export const PROGRESS_SCOPES = [28, 90, 'all'] as const;
export type ProgressScope = (typeof PROGRESS_SCOPES)[number];

export const PROGRESS_PROVIDERS = ['LICHESS', 'CHESSCOM'] as const;
export type ProgressProvider = (typeof PROGRESS_PROVIDERS)[number];

export const PROGRESS_TIME_CLASSES = [
    'BULLET',
    'BLITZ',
    'RAPID',
    'CLASSICAL',
    'UNKNOWN',
] as const;
export type ProgressTimeClass = (typeof PROGRESS_TIME_CLASSES)[number];

export type ProgressFilters = {
    providers: ProgressProvider[];
    timeClasses: ProgressTimeClass[];
};

export type ProgressWindow = {
    scope: ProgressScope;
    asOf: string;
    from: string | null;
    previousFrom: string | null;
    previousTo: string | null;
};

export type ProgressSampleState =
    | 'COUNTS_ONLY'
    | 'EARLY_SIGNAL'
    | 'ESTABLISHED';

/**
 * Every rate carries its numerator and denominator. For n < 10 the numerical
 * rate is deliberately withheld; consumers must render only "x of n".
 */
export type ProgressRate = {
    x: number;
    n: number;
    rate: number | null;
    sampleState: ProgressSampleState;
    confidence95: {
        low: number;
        high: number;
    } | null;
};

export type ProgressTrend = {
    status: 'SHOWN' | 'HIDDEN';
    reason:
        | 'AVAILABLE'
        | 'ALL_TIME_SCOPE'
        | 'CURRENT_SAMPLE_TOO_SMALL'
        | 'PREVIOUS_SAMPLE_TOO_SMALL'
        | 'CONFIG_CHANGED'
        | 'COVERAGE_CHANGED'
        | 'MIX_CHANGED';
    current: ProgressRate;
    previous: ProgressRate | null;
    difference: number | null;
    confidence95Difference: {
        low: number;
        high: number;
    } | null;
    direction: 'UP' | 'DOWN' | 'NO_CLEAR_CHANGE' | null;
};

export type ProgressAnalysisStateCounts = {
    imported: number;
    analyzed: number;
    stale: number;
    queued: number;
    running: number;
    failed: number;
    waiting: number;
};

export type ProgressCoverage = {
    basis: 'SOURCE_GAME_PLAYED_AT';
    analysisStates: ProgressAnalysisStateCounts;
    analyzedRate: ProgressRate;
    statesAreExclusive: true;
    strictValidity: {
        requiresCurrentRun: true;
        requiresSucceededRun: true;
        requiresCurrentPgnHash: true;
    };
    eligiblePositions: number;
    gamesWithEligiblePosition: ProgressRate;
    positionsPerAnalyzedGame: {
        positions: number;
        analyzedGames: number;
        average: number | null;
    };
};

export type ProgressAvailableOption<T extends string> = {
    key: T;
    sourceGames: number;
    terminalAttempts: number;
};

export type ProgressAvailability = {
    providers: ProgressAvailableOption<ProgressProvider>[];
    timeClasses: ProgressAvailableOption<ProgressTimeClass>[];
    hasDataOutsideScope: boolean;
    filteredEmpty: boolean;
};

export type ProgressGradeCounts = {
    BEST: number;
    STRONG: number;
    GOOD: number;
    IMPROVED: number;
    REPEATED_MISTAKE: number;
    DIFFERENT_MISTAKE: number;
};

export type ProgressFirstOutcome = {
    basis: 'FIRST_RECORDED_GRADED_OR_REVEALED_PER_POSITION';
    positions: number;
    graded: number;
    revealed: number;
    metObjective: ProgressRate;
    gradedFullSolve: ProgressRate;
    gradeCounts: ProgressGradeCounts;
};

export type ProgressPracticePerformance = {
    basis: 'TERMINAL_COMPLETED_AT';
    gradedAttempts: number;
    revealedAttempts: number;
    unresolvedExcluded: number;
    fullPositionSolve: ProgressRate;
    rootDecisionSuccess: ProgressRate;
    exactOriginalMoveRepeated: ProgressRate;
    gradeCounts: ProgressGradeCounts;
    fullPositionSolveTrend: ProgressTrend;
};

export type ProgressInventory = {
    basis: 'CURRENT_ELIGIBLE_LIBRARY';
    eligiblePositions: number;
    fresh: number;
    needsAnotherLook: number;
    persistentOriginalMoveRepetition: number;
};

export type ProgressPositionAction = {
    positionId: string;
    sourceGameId: string;
    reason:
        | 'LATEST_ORIGINAL_MOVE_REPEATED'
        | 'PERSISTENT_ORIGINAL_MOVE_REPETITION'
        | 'LATEST_FULL_POSITION_NOT_SOLVED'
        | 'REVEALED_WITHOUT_LATER_SOLVE';
    latestTerminalAt: string;
    latestGrade:
        | keyof ProgressGradeCounts
        | 'REVEALED';
    exactOriginalMoveRepeatCount: number;
    impact: {
        basis: 'WIN_CHANCE' | 'CENTIPAWN_FALLBACK' | 'UNKNOWN';
        bucket: 'LOW' | 'MEANINGFUL' | 'MAJOR' | 'UNKNOWN';
    };
    phase: 'OPENING' | 'MIDDLEGAME' | 'ENDGAME' | 'UNKNOWN';
    provider: ProgressProvider;
    timeClass: ProgressTimeClass;
    daysSinceLatestTerminal: number;
};

export type ProgressActions = {
    disclosure: 'ONLY_ALREADY_ATTEMPTED_POSITIONS_NO_PRE_ATTEMPT_THEME_CONTEXT';
    limitPerList: 20;
    needsAnotherLook: ProgressPositionAction[];
    persistentOriginalMoveRepetition: ProgressPositionAction[];
};

export type ProgressDelayedRecheck = {
    basis: 'FIRST_OBSERVED_RECHECK_7_TO_30_DAYS_AFTER_BASELINE';
    minimumDelayDays: 7;
    maximumDelayDays: 30;
    eligibleBaselines: number;
    observedRechecks: number;
    observationCoverage: ProgressRate;
    observedFullSolve: ProgressRate;
    disclosure: 'UNOBSERVED_RECHECKS_ARE_NOT_COUNTED_AS_FAILURES';
};

export type ProgressImpactBuckets = {
    winningChance: {
        low: number;
        meaningful: number;
        major: number;
    };
    centipawnFallback: {
        low: number;
        meaningful: number;
        major: number;
    };
    unknown: number;
    disclosure: 'WIN_CHANCE_PRIMARY_CP_ONLY_WHEN_WIN_CHANCE_MISSING';
};

export type ProgressBreakdownRow = {
    key: string;
    positions: number;
    sourceGames: number;
    gradedAttempts: number;
    fullPositionSolve: ProgressRate;
};

export type ProgressBreakdowns = {
    phase: ProgressBreakdownRow[];
    impact: ProgressBreakdownRow[];
    provider: ProgressBreakdownRow[];
    timeClass: ProgressBreakdownRow[];
    source: ProgressBreakdownRow[];
    basis: {
        positionAndSourceGameCounts: 'CURRENT_LIBRARY_SOURCE_GAME_PLAYED_AT';
        gradedAttemptCounts: 'TERMINAL_COMPLETED_AT_FROZEN_ATTEMPT_CONTEXT';
    };
    multiLabelDisclosure: {
        source: true;
        explanation: 'SOURCE_ROWS_OVERLAP_AND_MUST_NOT_BE_SUMMED';
    };
};

export type ProgressOperationalState = {
    linkedAccounts: {
        lichess: boolean;
        chesscom: boolean;
    };
    serverCreditsBalance: number | null;
    waitingForCredits: number;
    primaryState:
        | 'NO_LINKED_ACCOUNT'
        | 'NO_GAMES'
        | 'NO_ANALYSIS'
        | 'WAITING_FOR_CREDITS'
        | 'ANALYSIS_RUNNING'
        | 'ANALYSIS_QUEUED'
        | 'ANALYSIS_FAILED'
        | 'READY';
};

export type ProgressComparability = {
    currentConfigDistribution: Array<{
        key: string;
        count: number;
        share: number;
    }>;
    previousConfigDistribution: Array<{
        key: string;
        count: number;
        share: number;
    }>;
    comparableConfig: boolean;
    currentAnalysisCoverage: ProgressRate;
    previousAnalysisCoverage: ProgressRate | null;
    comparableMix: boolean;
    thresholds: {
        maximumCategoryShareDifference: 0.15;
    };
};

export type ProgressSnapshot = {
    definitionVersion: typeof PROGRESS_DEFINITION_VERSION;
    generatedAt: string;
    window: ProgressWindow;
    filters: ProgressFilters;
    availability: ProgressAvailability;
    operational: ProgressOperationalState;
    coverage: ProgressCoverage;
    firstRecordedTerminalOutcome: ProgressFirstOutcome;
    practice: ProgressPracticePerformance;
    inventory: ProgressInventory;
    actions: ProgressActions;
    delayedRecheck: ProgressDelayedRecheck;
    impact: ProgressImpactBuckets;
    breakdowns: ProgressBreakdowns;
    comparability: ProgressComparability;
    guardrails: {
        smallSample: {
            countsOnlyBelow: 10;
            earlySignalBelow: 50;
            confidence: 'WILSON_95';
        };
        trend: {
            minimumPerPeriod: 50;
            requiresComparableConfig: true;
            requiresComparableCoverage: false;
            requiresComparableMix: true;
            reportsConfidenceIntervalOfDifference: true;
        };
        exclusions: [
            'REVEALED_NOT_SOLVED',
            'UNRESOLVED_NOT_WRONG',
            'PENDING_NOT_TERMINAL',
            'SKIPPED_NOT_GRADED',
        ];
    };
};

export type ProgressRequest = {
    scope: ProgressScope;
    asOf: Date;
    filters: ProgressFilters;
};
