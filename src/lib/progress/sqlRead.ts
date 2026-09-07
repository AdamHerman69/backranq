import { Prisma } from '@prisma/client';
import type {
    ProgressFilters,
    ProgressPositionAction,
} from '@/lib/progress/contracts';

export type ProgressSqlClient = Pick<
    Prisma.TransactionClient,
    '$queryRaw'
>;

export type CountMap = Record<string, number>;

export type ProgressGamesSummary = {
    userExists: boolean;
    linkedAccounts: { lichess: boolean; chesscom: boolean };
    allGames: number;
    filteredHistoricalGames: number;
    currentStates: CountMap;
    previousStates: CountMap;
    operationalStates: CountMap;
    currentByProvider: CountMap;
    currentByTimeClass: CountMap;
    waitingForCredits: {
        creditReason: number;
        creditReasonOrWaiting: number;
    };
};

export type ProgressBreakdownSummary = {
    key: string;
    positions: number;
    sourceGames: number;
};

export type ProgressPositionsSummary = {
    currentEligiblePositions: number;
    currentEligibleGames: number;
    inventory: {
        eligiblePositions: number;
        fresh: number;
        needsAnotherLook: number;
        persistentOriginalMoveRepetition: number;
    };
    actions: {
        needsAnotherLook: ProgressPositionAction[];
        persistentOriginalMoveRepetition: ProgressPositionAction[];
    };
    impact: {
        winningChance: CountMap;
        centipawnFallback: CountMap;
        unknown: number;
    };
    breakdowns: Record<string, ProgressBreakdownSummary[]>;
};

export type AttemptBreakdownSummary = {
    key: string;
    resolvedAttempts: number;
    solvedAttempts: number;
};

export type DistributionSummary = {
    key: string;
    count: number;
};

export type ProgressAttemptsSummary = {
    filteredHistoricalAttempts: number;
    filteredCurrentAttempts: number;
    unfilteredCurrentAttempts: number;
    currentByProvider: CountMap;
    currentByTimeClass: CountMap;
    currentPractice: {
        resolved: number;
        revealed: number;
        unavailable: number;
        solved: number;
        rootObserved: number;
        rootSolved: number;
        rootRepeated: number;
        tierCounts: CountMap;
    };
    previousPractice: {
        resolved: number;
        solved: number;
    };
    firstOutcome: {
        positions: number;
        resolved: number;
        revealed: number;
        solved: number;
        tierCounts: CountMap;
    };
    delayedRecheck: {
        eligibleBaselines: number;
        observedRechecks: number;
        observedSolved: number;
    };
    currentConfig: DistributionSummary[];
    previousConfig: DistributionSummary[];
    currentMix: Record<string, DistributionSummary[]>;
    previousMix: Record<string, DistributionSummary[]>;
    breakdowns: Record<string, AttemptBreakdownSummary[]>;
};

type PayloadRow<T> = { payload: T };

function enumFilter(
    column: Prisma.Sql,
    values: readonly string[],
    enumName: 'GameSource' | 'TimeClass'
) {
    if (values.length === 0) return Prisma.sql`TRUE`;
    const typed = values.map(
        (value) => Prisma.sql`${value}::${Prisma.raw(`"${enumName}"`)}`
    );
    return Prisma.sql`${column} IN (${Prisma.join(typed)})`;
}

function gameFilter(
    filters: ProgressFilters,
    alias: 'g' | 'game' = 'g'
) {
    const provider =
        alias === 'g'
            ? Prisma.sql`g."provider"`
            : Prisma.sql`game."provider"`;
    const timeClass =
        alias === 'g'
            ? Prisma.sql`g."timeClass"`
            : Prisma.sql`game."timeClass"`;
    return Prisma.sql`${enumFilter(
        provider,
        filters.providers,
        'GameSource'
    )} AND ${enumFilter(
        timeClass,
        filters.timeClasses,
        'TimeClass'
    )}`;
}

function attemptFilter(filters: ProgressFilters) {
    return Prisma.sql`${enumFilter(
        Prisma.sql`attempt."contextProvider"`,
        filters.providers,
        'GameSource'
    )} AND ${enumFilter(
        Prisma.sql`attempt."contextTimeClass"`,
        filters.timeClasses,
        'TimeClass'
    )}`;
}

function jsonPayload<T>(rows: PayloadRow<T>[], dataset: string): T {
    const payload = rows[0]?.payload;
    if (!payload || rows.length !== 1) {
        throw new Error(`Progress ${dataset} aggregate returned no payload`);
    }
    return payload;
}

export async function readProgressGamesSummary(args: {
    db: ProgressSqlClient;
    userId: string;
    asOf: Date;
    from: Date | null;
    previousFrom: Date | null;
    previousTo: Date | null;
    filters: ProgressFilters;
}) {
    const rows = await args.db.$queryRaw<PayloadRow<ProgressGamesSummary>[]>(
        Prisma.sql`
            WITH games AS MATERIALIZED (
                SELECT
                    g."id",
                    g."provider",
                    g."timeClass",
                    g."playedAt",
                    (${gameFilter(args.filters)}) AS filtered,
                    (
                        g."currentAnalysisRunId" IS NOT NULL
                        AND g."currentAnalysisValid"
                        AND run."id" = g."currentAnalysisRunId"
                        AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
                        AND run."inputPgnHash" = g."sourcePgnHash"
                    ) AS strict_valid,
                    CASE
                        WHEN g."currentAnalysisRunId" IS NOT NULL
                            AND g."currentAnalysisValid"
                            AND run."id" = g."currentAnalysisRunId"
                            AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
                            AND run."inputPgnHash" = g."sourcePgnHash" THEN 'analyzed'
                        WHEN job."status" = 'RUNNING'::"AnalysisJobStatus"
                            OR run."status" = 'RUNNING'::"AnalysisRunStatus" THEN 'running'
                        WHEN job."status" = 'QUEUED'::"AnalysisJobStatus"
                            OR run."status" = 'QUEUED'::"AnalysisRunStatus" THEN 'queued'
                        WHEN job."status" = 'FAILED'::"AnalysisJobStatus"
                            OR run."status" = 'FAILED'::"AnalysisRunStatus" THEN 'failed'
                        WHEN g."currentAnalysisRunId" IS NOT NULL
                            OR run."id" IS NOT NULL
                            OR g."analyzedAt" IS NOT NULL THEN 'stale'
                        ELSE 'waiting'
                    END AS state,
                    COALESCE((
                        NOT (
                            g."currentAnalysisRunId" IS NOT NULL
                            AND g."currentAnalysisValid"
                            AND run."id" = g."currentAnalysisRunId"
                            AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
                            AND run."inputPgnHash" = g."sourcePgnHash"
                        )
                        AND lower(COALESCE(job."queuedReason", '')) LIKE '%credit%'
                    ), FALSE) AS credit_reason
                FROM "AnalyzedGame" g
                LEFT JOIN "AnalysisRun" run ON run."id" = g."currentAnalysisRunId"
                LEFT JOIN "AnalysisJob" job ON job."gameId" = g."id"
                WHERE g."userId" = ${args.userId}::uuid
                  AND g."playedAt" <= ${args.asOf}
            ), current_games AS (
                SELECT * FROM games
                WHERE filtered
                  AND "playedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "playedAt" >= ${args.from})
            ), previous_games AS (
                SELECT * FROM games
                WHERE filtered
                  AND ${args.previousFrom}::timestamptz IS NOT NULL
                  AND "playedAt" >= ${args.previousFrom}
                  AND "playedAt" < ${args.previousTo}
            ), unfiltered_current AS (
                SELECT * FROM games
                WHERE "playedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "playedAt" >= ${args.from})
            )
            SELECT jsonb_build_object(
                'userExists', EXISTS (SELECT 1 FROM "User" WHERE "id" = ${args.userId}::uuid),
                'linkedAccounts', jsonb_build_object(
                    'lichess', EXISTS (SELECT 1 FROM "ChessAccountConnection" WHERE "userId" = ${args.userId}::uuid AND "provider" = 'LICHESS'::"SyncProvider"),
                    'chesscom', EXISTS (SELECT 1 FROM "ChessAccountConnection" WHERE "userId" = ${args.userId}::uuid AND "provider" = 'CHESSCOM'::"SyncProvider")
                ),
                'allGames', (SELECT count(*) FROM games),
                'filteredHistoricalGames', (SELECT count(*) FROM games WHERE filtered),
                'currentStates', jsonb_build_object(
                    'imported', (SELECT count(*) FROM current_games),
                    'analyzed', (SELECT count(*) FROM current_games WHERE state = 'analyzed'),
                    'stale', (SELECT count(*) FROM current_games WHERE state = 'stale'),
                    'queued', (SELECT count(*) FROM current_games WHERE state = 'queued'),
                    'running', (SELECT count(*) FROM current_games WHERE state = 'running'),
                    'failed', (SELECT count(*) FROM current_games WHERE state = 'failed'),
                    'waiting', (SELECT count(*) FROM current_games WHERE state = 'waiting')
                ),
                'previousStates', jsonb_build_object(
                    'imported', (SELECT count(*) FROM previous_games),
                    'analyzed', (SELECT count(*) FROM previous_games WHERE state = 'analyzed'),
                    'stale', (SELECT count(*) FROM previous_games WHERE state = 'stale'),
                    'queued', (SELECT count(*) FROM previous_games WHERE state = 'queued'),
                    'running', (SELECT count(*) FROM previous_games WHERE state = 'running'),
                    'failed', (SELECT count(*) FROM previous_games WHERE state = 'failed'),
                    'waiting', (SELECT count(*) FROM previous_games WHERE state = 'waiting')
                ),
                'operationalStates', jsonb_build_object(
                    'imported', (SELECT count(*) FROM games),
                    'analyzed', (SELECT count(*) FROM games WHERE state = 'analyzed'),
                    'stale', (SELECT count(*) FROM games WHERE state = 'stale'),
                    'queued', (SELECT count(*) FROM games WHERE state = 'queued'),
                    'running', (SELECT count(*) FROM games WHERE state = 'running'),
                    'failed', (SELECT count(*) FROM games WHERE state = 'failed'),
                    'waiting', (SELECT count(*) FROM games WHERE state = 'waiting')
                ),
                'currentByProvider', COALESCE((
                    SELECT jsonb_object_agg("provider"::text, amount)
                    FROM (SELECT "provider", count(*) amount FROM unfiltered_current GROUP BY "provider") grouped
                ), '{}'::jsonb),
                'currentByTimeClass', COALESCE((
                    SELECT jsonb_object_agg("timeClass"::text, amount)
                    FROM (SELECT "timeClass", count(*) amount FROM unfiltered_current GROUP BY "timeClass") grouped
                ), '{}'::jsonb),
                'waitingForCredits', jsonb_build_object(
                    'creditReason', (SELECT count(*) FROM games WHERE credit_reason),
                    'creditReasonOrWaiting', (SELECT count(*) FROM games WHERE credit_reason OR state = 'waiting')
                )
            ) AS payload
        `
    );
    return jsonPayload(rows, 'games');
}

export async function readProgressPositionsSummary(args: {
    db: ProgressSqlClient;
    userId: string;
    asOf: Date;
    from: Date | null;
    filters: ProgressFilters;
}) {
    const rows = await args.db.$queryRaw<PayloadRow<ProgressPositionsSummary>[]>(
        Prisma.sql`
            WITH eligible AS MATERIALIZED (
                SELECT
                    moment."id",
                    moment."gameId",
                    moment."phase",
                    moment."sourceKinds",
                    moment."cpLoss",
                    moment."winChanceLoss",
                    game."provider",
                    game."timeClass",
                    game."playedAt",
                    revision."solutionHash",
                    revision."configHash",
                    CASE
                        WHEN moment."winChanceLoss" IS NOT NULL
                            AND moment."winChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity')
                            AND moment."winChanceLoss" >= 0 THEN 'WIN_CHANCE'
                        WHEN moment."cpLoss" IS NOT NULL
                            AND moment."cpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity')
                            AND moment."cpLoss" >= 0 THEN 'CENTIPAWN_FALLBACK'
                        ELSE 'UNKNOWN'
                    END AS impact_basis,
                    CASE
                        WHEN moment."winChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."winChanceLoss" >= 0.12 THEN 'MAJOR'
                        WHEN moment."winChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."winChanceLoss" >= 0.08 THEN 'MEANINGFUL'
                        WHEN moment."winChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."winChanceLoss" >= 0 THEN 'LOW'
                        WHEN moment."cpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."cpLoss" >= 150 THEN 'MAJOR'
                        WHEN moment."cpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."cpLoss" >= 100 THEN 'MEANINGFUL'
                        WHEN moment."cpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND moment."cpLoss" >= 0 THEN 'LOW'
                        ELSE 'UNKNOWN'
                    END AS impact_bucket
                FROM "TrainingMoment" moment
                JOIN "AnalyzedGame" game ON game."id" = moment."gameId" AND game."userId" = moment."userId"
                JOIN "AnalysisRun" run ON run."id" = game."currentAnalysisRunId"
                JOIN "SolutionRevision" revision ON revision."id" = moment."currentSolutionRevisionId"
                WHERE moment."userId" = ${args.userId}::uuid
                  AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
                  AND moment."archivedAt" IS NULL
                  AND game."playedAt" <= ${args.asOf}
                  AND (${gameFilter(args.filters, 'game')})
                  AND game."currentAnalysisValid"
                  AND run."status" = 'SUCCEEDED'::"AnalysisRunStatus"
                  AND run."inputPgnHash" = game."sourcePgnHash"
                  AND moment."sourcePgnHash" = run."inputPgnHash"
                  AND revision."id" = moment."currentSolutionRevisionId"
                  AND revision."trainable"
                  AND revision."manifest" @> '{"decision":{"status":"CONFIRMED_MISTAKE","selection":"INCLUDED"}}'::jsonb
                  AND revision."configHash" = run."configHash"
                  AND EXISTS (
                      SELECT 1 FROM "TrainingMomentObservation" observation
                      WHERE observation."momentId" = moment."id"
                        AND observation."solutionRevisionId" = revision."id"
                        AND observation."observedSolutionHash" = revision."solutionHash"
                  )
            ), current_eligible AS MATERIALIZED (
                SELECT * FROM eligible
                WHERE "playedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "playedAt" >= ${args.from})
            ), position_attempts AS MATERIALIZED (
                SELECT
                    attempt."id",
                    attempt."trainingMomentId",
                    attempt."completedAt",
                    attempt."status",
                    attempt."quality",
                    attempt."tier",
                    attempt."originalRelation",
                    attempt."contextConfigHash",
                    attempt."contextSolutionHash"
                FROM "TrainingAttempt" attempt
                WHERE attempt."userId" = ${args.userId}::uuid
                  AND attempt."completedAt" IS NOT NULL
                  AND attempt."completedAt" <= ${args.asOf}
                  AND attempt."status" IN ('RESOLVED'::"AttemptStatus", 'REVEALED'::"AttemptStatus")
            ), position_root_steps AS MATERIALIZED (
                SELECT DISTINCT ON (step."attemptId")
                    step."attemptId",
                    step."quality",
                    step."originalRelation"
                FROM "TrainingAttemptStep" step
                JOIN position_attempts attempt ON attempt."id" = step."attemptId"
                ORDER BY step."attemptId", step."stepIndex"
            ), attempts AS MATERIALIZED (
                SELECT
                    attempt."id",
                    attempt."trainingMomentId",
                    attempt."completedAt",
                    attempt."status",
                    attempt."quality",
                    attempt."tier",
                    attempt."originalRelation",
                    attempt."contextConfigHash",
                    attempt."contextSolutionHash",
                    root."quality" AS root_quality,
                    root."originalRelation" AS root_original_relation
                FROM position_attempts attempt
                LEFT JOIN position_root_steps root ON root."attemptId" = attempt."id"
            ), semantic AS MATERIALIZED (
                SELECT attempt.*
                FROM attempts attempt
                JOIN eligible position ON position."id" = attempt."trainingMomentId"
                WHERE attempt."contextSolutionHash" = position."solutionHash"
                  AND attempt."contextConfigHash" = position."configHash"
            ), semantic_stats AS (
                SELECT
                    "trainingMomentId",
                    count(*) AS terminal_count,
                    count(*) FILTER (
                        WHERE "status" = 'RESOLVED'::"AttemptStatus"
                          AND root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation"
                    ) AS resolved_repeated_count,
                    count(*) FILTER (WHERE root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation") AS persistent_repeated_count,
                    min("completedAt") FILTER (WHERE root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation") AS first_repeated_at,
                    max("completedAt") FILTER (WHERE root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation") AS last_repeated_at
                FROM semantic
                GROUP BY "trainingMomentId"
            ), latest_semantic AS (
                SELECT DISTINCT ON ("trainingMomentId") *
                FROM semantic
                ORDER BY "trainingMomentId", "completedAt" DESC, "id" DESC
            ), action_rows AS MATERIALIZED (
                SELECT
                    position.*,
                    latest."completedAt" AS latest_at,
                    latest."status" AS latest_status,
                    latest."quality" AS latest_quality,
                    latest."tier" AS latest_tier,
                    latest."originalRelation" AS latest_original_relation,
                    latest.root_quality AS latest_root_quality,
                    stats.resolved_repeated_count,
                    (
                        stats.persistent_repeated_count >= 2
                        AND stats.last_repeated_at - stats.first_repeated_at >= interval '1 day'
                    ) AS persistent,
                    CASE
                        WHEN latest."status" = 'RESOLVED'::"AttemptStatus"
                            AND latest.root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND latest.root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation" THEN 'LATEST_ORIGINAL_MOVE_REPEATED'
                        WHEN latest."status" = 'REVEALED'::"AttemptStatus" THEN 'REVEALED_WITHOUT_LATER_SOLVE'
                        WHEN latest."status" = 'RESOLVED'::"AttemptStatus"
                            AND (latest."quality" IS NULL OR latest."quality" <> 'GOOD'::"AttemptQuality")
                            AND stats.persistent_repeated_count >= 2
                            AND stats.last_repeated_at - stats.first_repeated_at >= interval '1 day'
                            THEN 'PERSISTENT_ORIGINAL_MOVE_REPETITION'
                        WHEN latest."status" = 'RESOLVED'::"AttemptStatus"
                            AND (latest."quality" IS NULL OR latest."quality" <> 'GOOD'::"AttemptQuality")
                            THEN 'LATEST_FULL_POSITION_NOT_SOLVED'
                        ELSE NULL
                    END AS reason,
                    floor(extract(epoch FROM (${args.asOf} - latest."completedAt")) / 86400)::int AS days_since
                FROM eligible position
                JOIN latest_semantic latest ON latest."trainingMomentId" = position."id"
                JOIN semantic_stats stats ON stats."trainingMomentId" = position."id"
            ), actionable AS MATERIALIZED (
                SELECT *,
                    CASE reason
                        WHEN 'LATEST_ORIGINAL_MOVE_REPEATED' THEN 0
                        WHEN 'PERSISTENT_ORIGINAL_MOVE_REPETITION' THEN 1
                        WHEN 'LATEST_FULL_POSITION_NOT_SOLVED' THEN 2
                        ELSE 3
                    END AS reason_rank,
                    CASE impact_bucket WHEN 'MAJOR' THEN 0 WHEN 'MEANINGFUL' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END AS impact_rank
                FROM action_rows
                WHERE reason IS NOT NULL
            ), position_dimensions AS MATERIALIZED (
                SELECT 'phase' AS dimension, COALESCE("phase"::text, 'UNKNOWN') AS key, "id", "gameId" FROM current_eligible
                UNION ALL
                SELECT 'impact', CASE WHEN impact_basis = 'UNKNOWN' THEN 'UNKNOWN' ELSE impact_basis || '_' || impact_bucket END, "id", "gameId" FROM current_eligible
                UNION ALL
                SELECT 'provider', "provider"::text, "id", "gameId" FROM current_eligible
                UNION ALL
                SELECT 'timeClass', "timeClass"::text, "id", "gameId" FROM current_eligible
                UNION ALL
                SELECT 'source', source.key, position."id", position."gameId"
                FROM current_eligible position
                CROSS JOIN LATERAL (
                    SELECT value::text AS key FROM unnest(position."sourceKinds") value
                    UNION ALL SELECT 'UNKNOWN' WHERE cardinality(position."sourceKinds") = 0
                ) source
            ), position_breakdowns AS (
                SELECT dimension, jsonb_agg(jsonb_build_object(
                    'key', key,
                    'positions', positions,
                    'sourceGames', source_games
                ) ORDER BY key) AS rows
                FROM (
                    SELECT dimension, key, count(DISTINCT "id") positions, count(DISTINCT "gameId") source_games
                    FROM position_dimensions
                    GROUP BY dimension, key
                ) grouped
                GROUP BY dimension
            )
            SELECT jsonb_build_object(
                'currentEligiblePositions', (SELECT count(*) FROM current_eligible),
                'currentEligibleGames', (SELECT count(DISTINCT "gameId") FROM current_eligible),
                'inventory', jsonb_build_object(
                    'eligiblePositions', (SELECT count(*) FROM eligible),
                    'fresh', (SELECT count(*) FROM eligible position WHERE NOT EXISTS (SELECT 1 FROM semantic WHERE "trainingMomentId" = position."id")),
                    'needsAnotherLook', (SELECT count(*) FROM actionable),
                    'persistentOriginalMoveRepetition', (SELECT count(*) FROM actionable WHERE persistent)
                ),
                'actions', jsonb_build_object(
                    'needsAnotherLook', COALESCE((
                        SELECT jsonb_agg(action ORDER BY reason_rank, impact_rank, days_since DESC, "id")
                        FROM (
                            SELECT reason_rank, impact_rank, days_since, "id", jsonb_build_object(
                                'positionId', "id"::text,
                                'sourceGameId', "gameId"::text,
                                'reason', reason,
                                'latestTerminalAt', to_char(latest_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                                'latestStatus', latest_status::text, 'latestQuality', latest_quality::text, 'latestTier', latest_tier::text, 'latestOriginalRelation', latest_original_relation::text,
                                'exactOriginalMoveRepeatCount', resolved_repeated_count,
                                'impact', jsonb_build_object('basis', impact_basis, 'bucket', impact_bucket),
                                'phase', COALESCE("phase"::text, 'UNKNOWN'),
                                'provider', "provider"::text,
                                'timeClass', "timeClass"::text,
                                'daysSinceLatestTerminal', days_since
                            ) action
                            FROM actionable
                            ORDER BY reason_rank, impact_rank, days_since DESC, "id"
                            LIMIT 20
                        ) ranked
                    ), '[]'::jsonb),
                    'persistentOriginalMoveRepetition', COALESCE((
                        SELECT jsonb_agg(action ORDER BY reason_rank, impact_rank, days_since DESC, "id")
                        FROM (
                            SELECT reason_rank, impact_rank, days_since, "id", jsonb_build_object(
                                'positionId', "id"::text,
                                'sourceGameId', "gameId"::text,
                                'reason', reason,
                                'latestTerminalAt', to_char(latest_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                                'latestStatus', latest_status::text, 'latestQuality', latest_quality::text, 'latestTier', latest_tier::text, 'latestOriginalRelation', latest_original_relation::text,
                                'exactOriginalMoveRepeatCount', resolved_repeated_count,
                                'impact', jsonb_build_object('basis', impact_basis, 'bucket', impact_bucket),
                                'phase', COALESCE("phase"::text, 'UNKNOWN'),
                                'provider', "provider"::text,
                                'timeClass', "timeClass"::text,
                                'daysSinceLatestTerminal', days_since
                            ) action
                            FROM actionable
                            WHERE persistent
                            ORDER BY reason_rank, impact_rank, days_since DESC, "id"
                            LIMIT 20
                        ) ranked
                    ), '[]'::jsonb)
                ),
                'impact', jsonb_build_object(
                    'winningChance', jsonb_build_object(
                        'low', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'WIN_CHANCE' AND impact_bucket = 'LOW'),
                        'meaningful', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'WIN_CHANCE' AND impact_bucket = 'MEANINGFUL'),
                        'major', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'WIN_CHANCE' AND impact_bucket = 'MAJOR')
                    ),
                    'centipawnFallback', jsonb_build_object(
                        'low', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'CENTIPAWN_FALLBACK' AND impact_bucket = 'LOW'),
                        'meaningful', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'CENTIPAWN_FALLBACK' AND impact_bucket = 'MEANINGFUL'),
                        'major', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'CENTIPAWN_FALLBACK' AND impact_bucket = 'MAJOR')
                    ),
                    'unknown', (SELECT count(*) FROM current_eligible WHERE impact_basis = 'UNKNOWN')
                ),
                'breakdowns', COALESCE((SELECT jsonb_object_agg(dimension, rows) FROM position_breakdowns), '{}'::jsonb)
            ) AS payload
        `
    );
    return jsonPayload(rows, 'positions');
}

type ProgressAttemptsSummaryArgs = {
    db: ProgressSqlClient;
    userId: string;
    asOf: Date;
    from: Date | null;
    previousFrom: Date | null;
    previousTo: Date | null;
    filters: ProgressFilters;
};

function progressAttemptsSummaryQuery(args: ProgressAttemptsSummaryArgs) {
    return Prisma.sql`
            WITH selected_attempts AS MATERIALIZED (
                SELECT
                    attempt."id",
                    attempt."trainingMomentId",
                    attempt."completedAt",
                    attempt."status",
                    attempt."quality",
                    attempt."tier",
                    attempt."originalRelation",
                    attempt."contextConfigHash",
                    attempt."contextSolutionHash",
                    attempt."contextProvider",
                    attempt."contextTimeClass",
                    attempt."contextPhase",
                    attempt."contextCpLoss",
                    attempt."contextWinChanceLoss",
                    attempt."contextSourceKinds",
                    CASE
                        WHEN attempt."contextWinChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextWinChanceLoss" >= 0.12 THEN 'WIN_CHANCE_MAJOR'
                        WHEN attempt."contextWinChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextWinChanceLoss" >= 0.08 THEN 'WIN_CHANCE_MEANINGFUL'
                        WHEN attempt."contextWinChanceLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextWinChanceLoss" >= 0 THEN 'WIN_CHANCE_LOW'
                        WHEN attempt."contextCpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextCpLoss" >= 150 THEN 'CENTIPAWN_FALLBACK_MAJOR'
                        WHEN attempt."contextCpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextCpLoss" >= 100 THEN 'CENTIPAWN_FALLBACK_MEANINGFUL'
                        WHEN attempt."contextCpLoss"::text NOT IN ('NaN', 'Infinity', '-Infinity') AND attempt."contextCpLoss" >= 0 THEN 'CENTIPAWN_FALLBACK_LOW'
                        ELSE 'UNKNOWN'
                    END AS impact_key,
                    COALESCE((
                        SELECT string_agg(value::text, '+' ORDER BY value::text)
                        FROM unnest(attempt."contextSourceKinds") value
                    ), 'UNKNOWN') AS source_mix_key,
                    (${attemptFilter(args.filters)}) AS filtered
                FROM "TrainingAttempt" attempt
                WHERE attempt."userId" = ${args.userId}::uuid
                  AND attempt."completedAt" IS NOT NULL
                  AND attempt."completedAt" <= ${args.asOf}
                  AND attempt."status" IN (
                      'RESOLVED'::"AttemptStatus",
                      'REVEALED'::"AttemptStatus",
                      'UNAVAILABLE'::"AttemptStatus"
                  )
            ), root_steps AS MATERIALIZED (
                SELECT DISTINCT ON (step."attemptId")
                    step."attemptId",
                    step."quality",
                    step."originalRelation"
                FROM "TrainingAttemptStep" step
                JOIN selected_attempts attempt ON attempt."id" = step."attemptId"
                ORDER BY step."attemptId", step."stepIndex"
            ), attempts AS MATERIALIZED (
                SELECT
                    attempt."id",
                    attempt."trainingMomentId",
                    attempt."completedAt",
                    attempt."status",
                    attempt."quality",
                    attempt."tier",
                    attempt."originalRelation",
                    attempt."contextConfigHash",
                    attempt."contextSolutionHash",
                    attempt."contextProvider",
                    attempt."contextTimeClass",
                    attempt."contextPhase",
                    attempt."contextCpLoss",
                    attempt."contextWinChanceLoss",
                    attempt."contextSourceKinds",
                    attempt.impact_key,
                    attempt.source_mix_key,
                    attempt.filtered,
                    root."quality" AS root_quality,
                    root."originalRelation" AS root_original_relation
                FROM selected_attempts attempt
                LEFT JOIN root_steps root ON root."attemptId" = attempt."id"
            ), current_attempts AS MATERIALIZED (
                SELECT * FROM attempts
                WHERE filtered
                  AND "completedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "completedAt" >= ${args.from})
            ), previous_attempts AS MATERIALIZED (
                SELECT * FROM attempts
                WHERE filtered
                  AND ${args.previousFrom}::timestamptz IS NOT NULL
                  AND "completedAt" >= ${args.previousFrom}
                  AND "completedAt" < ${args.previousTo}
            ), unfiltered_current AS MATERIALIZED (
                SELECT * FROM attempts
                WHERE "completedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "completedAt" >= ${args.from})
            ), filtered_terminal AS MATERIALIZED (
                SELECT * FROM attempts
                WHERE filtered AND "status" IN ('RESOLVED'::"AttemptStatus", 'REVEALED'::"AttemptStatus")
            ), ordered_terminal AS MATERIALIZED (
                SELECT terminal.*,
                    lead("completedAt") OVER terminal_order AS next_completed_at,
                    lead("status") OVER terminal_order AS next_status,
                    lead("quality") OVER terminal_order AS next_quality
                FROM filtered_terminal terminal
                WINDOW terminal_order AS (
                    PARTITION BY "trainingMomentId", "contextSolutionHash", "contextConfigHash"
                    ORDER BY "completedAt", "id"
                )
            ), first_terminal AS (
                SELECT DISTINCT ON ("trainingMomentId") *
                FROM ordered_terminal
                ORDER BY "trainingMomentId", "completedAt", "id"
            ), first_current AS (
                SELECT * FROM first_terminal
                WHERE "completedAt" < ${args.asOf}
                  AND (${args.from}::timestamptz IS NULL OR "completedAt" >= ${args.from})
            ), baselines AS MATERIALIZED (
                SELECT DISTINCT ON ("trainingMomentId") *
                FROM ordered_terminal
                WHERE "status" = 'RESOLVED'::"AttemptStatus"
                  AND "quality" = 'GOOD'::"AttemptQuality"
                ORDER BY "trainingMomentId", "completedAt", "id"
            ), delayed AS MATERIALIZED (
                SELECT baseline.*, baseline.next_completed_at AS recheck_at,
                    baseline.next_status AS recheck_status,
                    baseline.next_quality AS recheck_quality
                FROM baselines baseline
                WHERE ${args.asOf} - baseline."completedAt" >= interval '7 days'
                  AND (
                      baseline.next_completed_at IS NULL
                      OR baseline.next_completed_at - baseline."completedAt" >= interval '7 days'
                  )
            ), attempt_dimensions AS MATERIALIZED (
                SELECT 'phase' AS dimension, COALESCE("contextPhase"::text, 'UNKNOWN') AS key, "quality" FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'impact', impact_key, "quality" FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'provider', "contextProvider"::text, "quality" FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'timeClass', "contextTimeClass"::text, "quality" FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL
                SELECT 'source', source.key, attempt."quality"
                FROM current_attempts attempt
                CROSS JOIN LATERAL (
                    SELECT value::text AS key FROM unnest(attempt."contextSourceKinds") value
                    UNION ALL SELECT 'UNKNOWN' WHERE cardinality(attempt."contextSourceKinds") = 0
                ) source
                WHERE attempt."status" = 'RESOLVED'::"AttemptStatus"
            ), attempt_breakdowns AS (
                SELECT dimension, jsonb_agg(jsonb_build_object(
                    'key', key,
                    'resolvedAttempts', resolved,
                    'solvedAttempts', solved
                ) ORDER BY key) AS rows
                FROM (
                    SELECT dimension, key, count(*) resolved,
                        count(*) FILTER (WHERE "quality" = 'GOOD'::"AttemptQuality") solved
                    FROM attempt_dimensions
                    GROUP BY dimension, key
                ) grouped
                GROUP BY dimension
            ), current_mix_rows AS MATERIALIZED (
                SELECT 'provider' dimension, "contextProvider"::text key FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'timeClass', "contextTimeClass"::text FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'source', source_mix_key FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'phase', COALESCE("contextPhase"::text, 'UNKNOWN') FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'impact', impact_key FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
            ), previous_mix_rows AS MATERIALIZED (
                SELECT 'provider' dimension, "contextProvider"::text key FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'timeClass', "contextTimeClass"::text FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'source', source_mix_key FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'phase', COALESCE("contextPhase"::text, 'UNKNOWN') FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
                UNION ALL SELECT 'impact', impact_key FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus"
            ), current_mix AS (
                SELECT dimension, jsonb_agg(jsonb_build_object('key', key, 'count', amount) ORDER BY key) rows
                FROM (SELECT dimension, key, count(*) amount FROM current_mix_rows GROUP BY dimension, key) grouped GROUP BY dimension
            ), previous_mix AS (
                SELECT dimension, jsonb_agg(jsonb_build_object('key', key, 'count', amount) ORDER BY key) rows
                FROM (SELECT dimension, key, count(*) amount FROM previous_mix_rows GROUP BY dimension, key) grouped GROUP BY dimension
            )
            SELECT jsonb_build_object(
                'filteredHistoricalAttempts', (SELECT count(*) FROM attempts WHERE filtered),
                'filteredCurrentAttempts', (SELECT count(*) FROM current_attempts),
                'unfilteredCurrentAttempts', (SELECT count(*) FROM unfiltered_current),
                'currentByProvider', COALESCE((SELECT jsonb_object_agg("contextProvider"::text, amount) FROM (SELECT "contextProvider", count(*) amount FROM unfiltered_current GROUP BY "contextProvider") grouped), '{}'::jsonb),
                'currentByTimeClass', COALESCE((SELECT jsonb_object_agg("contextTimeClass"::text, amount) FROM (SELECT "contextTimeClass", count(*) amount FROM unfiltered_current GROUP BY "contextTimeClass") grouped), '{}'::jsonb),
                'currentPractice', jsonb_build_object(
                    'resolved', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality"),
                    'revealed', (SELECT count(*) FROM current_attempts WHERE "status" = 'REVEALED'::"AttemptStatus"),
                    'unavailable', (SELECT count(*) FROM current_attempts WHERE "status" = 'UNAVAILABLE'::"AttemptStatus"),
                    'solved', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" = 'GOOD'::"AttemptQuality"),
                    'rootObserved', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality" AND root_quality <> 'UNKNOWN'::"AttemptQuality"),
                    'rootSolved', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality" AND root_quality = 'GOOD'::"AttemptQuality"),
                    'rootRepeated', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality" AND root_quality = 'BELOW_STANDARD'::"AttemptQuality" AND root_original_relation = 'SAME_MOVE'::"AttemptOriginalRelation"),
                    'tierCounts', jsonb_build_object(
                        'BEST', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'BEST'::"AttemptTier"),
                        'STRONG', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'STRONG'::"AttemptTier"),
                        'GOOD', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'GOOD'::"AttemptTier"),
                        'SUBPAR', (SELECT count(*) FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'SUBPAR'::"AttemptTier")
                    )
                ),
                'previousPractice', jsonb_build_object(
                    'resolved', (SELECT count(*) FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality"),
                    'solved', (SELECT count(*) FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" = 'GOOD'::"AttemptQuality")
                ),
                'firstOutcome', jsonb_build_object(
                    'positions', (SELECT count(*) FROM first_current),
                    'resolved', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" <> 'UNKNOWN'::"AttemptQuality"),
                    'revealed', (SELECT count(*) FROM first_current WHERE "status" = 'REVEALED'::"AttemptStatus"),
                    'solved', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "quality" = 'GOOD'::"AttemptQuality"),
                    'tierCounts', jsonb_build_object(
                        'BEST', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'BEST'::"AttemptTier"),
                        'STRONG', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'STRONG'::"AttemptTier"),
                        'GOOD', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'GOOD'::"AttemptTier"),
                        'SUBPAR', (SELECT count(*) FROM first_current WHERE "status" = 'RESOLVED'::"AttemptStatus" AND "tier" = 'SUBPAR'::"AttemptTier")
                    )
                ),
                'delayedRecheck', jsonb_build_object(
                    'eligibleBaselines', (SELECT count(*) FROM delayed),
                    'observedRechecks', (SELECT count(*) FROM delayed WHERE recheck_at IS NOT NULL AND recheck_at - "completedAt" <= interval '30 days'),
                    'observedSolved', (SELECT count(*) FROM delayed WHERE recheck_at IS NOT NULL AND recheck_at - "completedAt" <= interval '30 days' AND recheck_status = 'RESOLVED'::"AttemptStatus" AND recheck_quality = 'GOOD'::"AttemptQuality")
                ),
                'currentConfig', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', "contextConfigHash", 'count', amount) ORDER BY "contextConfigHash") FROM (SELECT "contextConfigHash", count(*) amount FROM current_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" GROUP BY "contextConfigHash") grouped), '[]'::jsonb),
                'previousConfig', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', "contextConfigHash", 'count', amount) ORDER BY "contextConfigHash") FROM (SELECT "contextConfigHash", count(*) amount FROM previous_attempts WHERE "status" = 'RESOLVED'::"AttemptStatus" GROUP BY "contextConfigHash") grouped), '[]'::jsonb),
                'currentMix', COALESCE((SELECT jsonb_object_agg(dimension, rows) FROM current_mix), '{}'::jsonb),
                'previousMix', COALESCE((SELECT jsonb_object_agg(dimension, rows) FROM previous_mix), '{}'::jsonb),
                'breakdowns', COALESCE((SELECT jsonb_object_agg(dimension, rows) FROM attempt_breakdowns), '{}'::jsonb)
            ) AS payload
        `;
}

export async function readProgressAttemptsSummary(
    args: ProgressAttemptsSummaryArgs
) {
    const rows = await args.db.$queryRaw<PayloadRow<ProgressAttemptsSummary>[]>(
        progressAttemptsSummaryQuery(args)
    );
    return jsonPayload(rows, 'attempts');
}

export const progressSqlTestUtils = {
    progressAttemptsSummaryQuery,
};
