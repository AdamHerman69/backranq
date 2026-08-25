import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateProgressSnapshot } from '@/lib/progress/aggregate';
import { progressReadTestUtils } from '@/lib/progress/readService';
import { progressSqlTestUtils } from '@/lib/progress/sqlRead';

const runPostgresIntegration =
    process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true';
const runProgressScaleIntegration =
    runPostgresIntegration &&
    process.env.BACKRANQ_PROGRESS_SCALE_INTEGRATION === 'true';
const integration = describe.runIf(runPostgresIntegration);
const db = new PrismaClient();
const ids = {
    user: '10000000-0000-4000-8000-000000000031',
    game: '10000000-0000-4000-8000-000000000032',
    run: '10000000-0000-4000-8000-000000000033',
    moment: '10000000-0000-4000-8000-000000000034',
    revision: '10000000-0000-4000-8000-000000000035',
    repeatedOne: '10000000-0000-4000-8000-000000000036',
    repeatedTwo: '10000000-0000-4000-8000-000000000037',
    baseline: '10000000-0000-4000-8000-000000000038',
    recheck: '10000000-0000-4000-8000-000000000039',
};
const asOf = new Date('2026-08-23T12:00:00.000Z');
const playedAt = new Date('2026-07-01T12:00:00.000Z');
const sourcePgnHash = 'progress-source-hash';
const configHash = 'progress-config-hash';
const solutionHash = 'progress-solution-hash';
const attemptTimes = {
    repeatedOne: new Date('2026-07-10T12:00:00.000Z'),
    repeatedTwo: new Date('2026-07-12T12:00:00.000Z'),
    baseline: new Date('2026-07-20T12:00:00.000Z'),
    recheck: new Date('2026-07-28T12:00:00.000Z'),
};

async function seedProgressFixture() {
    await db.user.deleteMany({ where: { id: ids.user } });
    await db.user.create({
        data: {
            id: ids.user,
            email: 'progress-reader@backranq.test',
            preferences: {},
            chessAccountConnections: {
                create: {
                    provider: 'LICHESS',
                    providerAccountId: 'progress-reader',
                    username: 'progress-reader',
                    usernameNormalized: 'progress-reader',
                    origin: 'PUBLIC_PROFILE',
                },
            },
        },
    });
    await db.analyzedGame.create({
        data: {
            id: ids.game,
            userId: ids.user,
            provider: 'LICHESS',
            externalId: 'progress-game',
            pgn: '1. e4 e5 2. Nf3 Nc6 *',
            plyCount: 4,
            sourcePgnHash,
            sourceUsername: 'progress-reader',
            userSide: 'WHITE',
            playedAt,
            timeClass: 'RAPID',
            whiteName: 'progress-reader',
            blackName: 'opponent',
            analysis: {},
            analyzedAt: new Date('2026-07-01T12:05:00.000Z'),
        },
    });
    await db.analysisRun.create({
        data: {
            id: ids.run,
            userId: ids.user,
            gameId: ids.game,
            executionMode: 'LOCAL_BROWSER',
            analysisQuality: 'THOROUGH',
            creditCost: 0,
            status: 'SUCCEEDED',
            inputPgnHash: sourcePgnHash,
            configHash,
            completedAt: new Date('2026-07-01T12:05:00.000Z'),
        },
    });
    await db.analyzedGame.update({
        where: { id: ids.game },
        data: {
            currentAnalysisRunId: ids.run,
            currentAnalysisValid: true,
        },
    });
    await db.trainingMoment.create({
        data: {
            id: ids.moment,
            userId: ids.user,
            gameId: ids.game,
            momentKey: 'progress-moment-key',
            sourcePgnHash,
            decisionPly: 12,
            fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
            sideToMove: 'w',
            originalMoveUci: 'a1a2',
            scoreBefore: { cp: 100 },
            scoreAfter: { cp: -80 },
            cpLoss: 180,
            winChanceLoss: null,
            phase: 'ENDGAME',
            status: 'ACTIVE',
            sourceKinds: ['MY_MISTAKE'],
        },
    });
    await db.solutionRevision.create({
        data: {
            id: ids.revision,
            momentId: ids.moment,
            analysisRunId: ids.run,
            revision: 1,
            solutionHash,
            verificationStatus: 'VERIFIED',
            solutionShape: 'UNIQUE',
            gradingStrategy: 'PRECOMPUTED',
            continuationShape: 'SINGLE_DECISION',
            trainable: true,
            bestMoveUci: 'a1b1',
            acceptedMovesUci: ['a1b1'],
            acceptanceFrontier: { status: 'STABLE' },
            bestLine: ['a1b1'],
            targetOutcome: {},
            gradingPolicy: {},
            generatorVersion: 'progress-integration-v1',
            configHash,
        },
    });
    await db.trainingMoment.update({
        where: { id: ids.moment },
        data: { currentSolutionRevisionId: ids.revision },
    });
    await db.trainingMomentObservation.create({
        data: {
            momentId: ids.moment,
            analysisRunId: ids.run,
            solutionRevisionId: ids.revision,
            observedSolutionHash: solutionHash,
        },
    });

    const attempts = [
        {
            id: ids.repeatedOne,
            clientAttemptId: 'progress-repeated-one',
            completedAt: attemptTimes.repeatedOne,
            status: 'GRADED' as const,
            grade: 'REPEATED_MISTAKE' as const,
            rootGrade: 'REPEATED_MISTAKE' as const,
        },
        {
            id: ids.repeatedTwo,
            clientAttemptId: 'progress-repeated-two',
            completedAt: attemptTimes.repeatedTwo,
            status: 'GRADED' as const,
            grade: 'REPEATED_MISTAKE' as const,
            rootGrade: 'REPEATED_MISTAKE' as const,
        },
        {
            id: ids.baseline,
            clientAttemptId: 'progress-baseline',
            completedAt: attemptTimes.baseline,
            status: 'GRADED' as const,
            grade: 'BEST' as const,
            rootGrade: 'BEST' as const,
        },
        {
            id: ids.recheck,
            clientAttemptId: 'progress-recheck',
            completedAt: attemptTimes.recheck,
            status: 'REVEALED' as const,
            grade: null,
            rootGrade: 'REPEATED_MISTAKE' as const,
        },
    ];
    await db.trainingAttempt.createMany({
        data: attempts.map(({ rootGrade, ...attempt }) => {
            void rootGrade;
            return {
                ...attempt,
                trainingMomentId: ids.moment,
                userId: ids.user,
                solutionRevisionId: ids.revision,
                clientPayloadHash: attempt.clientAttemptId,
                attemptedAt: attempt.completedAt,
                userMoveUci:
                    attempt.status === 'REVEALED' ? null : 'a1a2',
                contextPhase: 'ENDGAME' as const,
                contextCpLoss: 180,
                contextWinChanceLoss: null,
                contextSourceKinds: ['MY_MISTAKE' as const],
                contextProvider: 'LICHESS' as const,
                contextTimeClass: 'RAPID' as const,
                contextConfigHash: configHash,
                contextSolutionHash: solutionHash,
            };
        }),
    });
    await db.trainingAttemptStep.createMany({
        data: attempts
            .filter((attempt) => attempt.rootGrade !== null)
            .map((attempt) => ({
                attemptId: attempt.id,
                stepIndex: 0,
                actor: 'USER' as const,
                fenBefore: '8/8/8/8/8/8/8/K6k w - - 0 1',
                moveUci: 'a1a2',
                grade: attempt.rootGrade,
            })),
    });
}

async function seedProgressScaleFixture() {
    await db.$executeRaw(Prisma.sql`
        WITH generated AS (
            SELECT
                n,
                (
                    substr(md5('scale-moment-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-moment-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 21, 12)
                )::uuid AS moment_id
            FROM generate_series(1, 1000) n
        )
        INSERT INTO "TrainingMoment" (
            "id", "userId", "gameId", "momentKey", "sourcePgnHash",
            "decisionPly", "fen", "positionHistory", "sideToMove",
            "originalMoveUci", "scoreBefore", "scoreAfter", "cpLoss",
            "phase", "status", "sourceKinds", "createdAt", "updatedAt"
        )
        SELECT
            moment_id,
            ${ids.user}::uuid,
            ${ids.game}::uuid,
            'progress-scale-moment-' || n::text,
            ${sourcePgnHash},
            1000 + n,
            '8/8/8/8/8/8/8/K6k w - - 0 1',
            ARRAY[]::text[],
            'w',
            'a1a2',
            '{"cp":100}'::jsonb,
            '{"cp":-80}'::jsonb,
            180,
            'ENDGAME'::"GamePhase",
            'ACTIVE'::"TrainingMomentStatus",
            ARRAY['MY_MISTAKE'::"TrainingSourceKind"],
            ${playedAt},
            ${playedAt}
        FROM generated
    `);
    await db.$executeRaw(Prisma.sql`
        WITH generated AS (
            SELECT
                n,
                (
                    substr(md5('scale-moment-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-moment-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 21, 12)
                )::uuid AS moment_id,
                (
                    substr(md5('scale-revision-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-revision-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 21, 12)
                )::uuid AS revision_id
            FROM generate_series(1, 1000) n
        )
        INSERT INTO "SolutionRevision" (
            "id", "momentId", "analysisRunId", "revision", "solutionHash",
            "verificationStatus", "solutionShape", "gradingStrategy",
            "continuationShape", "trainable", "bestMoveUci",
            "acceptedMovesUci", "acceptanceFrontier", "bestLine",
            "targetOutcome", "gradingPolicy", "generatorVersion", "configHash"
        )
        SELECT
            revision_id,
            moment_id,
            ${ids.run}::uuid,
            1,
            'progress-scale-solution-' || n::text,
            'VERIFIED'::"VerificationStatus",
            'UNIQUE'::"SolutionShape",
            'PRECOMPUTED'::"GradingStrategy",
            'SINGLE_DECISION'::"ContinuationShape",
            TRUE,
            'a1b1',
            ARRAY['a1b1'],
            '{"status":"STABLE"}'::jsonb,
            '["a1b1"]'::jsonb,
            '{}'::jsonb,
            '{}'::jsonb,
            'progress-scale-v1',
            ${configHash}
        FROM generated
    `);
    await db.$executeRaw(Prisma.sql`
        WITH generated AS (
            SELECT
                (
                    substr(md5('scale-moment-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-moment-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 21, 12)
                )::uuid AS moment_id,
                (
                    substr(md5('scale-revision-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-revision-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 21, 12)
                )::uuid AS revision_id
            FROM generate_series(1, 1000) n
        )
        UPDATE "TrainingMoment" moment
        SET "currentSolutionRevisionId" = generated.revision_id
        FROM generated
        WHERE moment."id" = generated.moment_id
    `);
    await db.$executeRaw(Prisma.sql`
        WITH generated AS (
            SELECT
                n,
                (
                    substr(md5('scale-moment-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-moment-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-moment-' || n::text), 21, 12)
                )::uuid AS moment_id,
                (
                    substr(md5('scale-revision-' || n::text), 1, 8) || '-' ||
                    substr(md5('scale-revision-' || n::text), 9, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 13, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 17, 4) || '-' ||
                    substr(md5('scale-revision-' || n::text), 21, 12)
                )::uuid AS revision_id
            FROM generate_series(1, 1000) n
        )
        INSERT INTO "TrainingMomentObservation" (
            "momentId", "analysisRunId", "solutionRevisionId",
            "observedSolutionHash"
        )
        SELECT
            moment_id,
            ${ids.run}::uuid,
            revision_id,
            'progress-scale-solution-' || n::text
        FROM generated
    `);
    await db.$executeRaw(Prisma.sql`
        WITH generated AS (
            SELECT
                i,
                ((i - 1) % 1000) + 1 AS moment_number
            FROM generate_series(1, 100000) i
        ), identified AS (
            SELECT
                generated.*,
                (
                    substr(md5('scale-attempt-' || i::text), 1, 8) || '-' ||
                    substr(md5('scale-attempt-' || i::text), 9, 4) || '-' ||
                    substr(md5('scale-attempt-' || i::text), 13, 4) || '-' ||
                    substr(md5('scale-attempt-' || i::text), 17, 4) || '-' ||
                    substr(md5('scale-attempt-' || i::text), 21, 12)
                )::uuid AS attempt_id,
                (
                    substr(md5('scale-moment-' || moment_number::text), 1, 8) || '-' ||
                    substr(md5('scale-moment-' || moment_number::text), 9, 4) || '-' ||
                    substr(md5('scale-moment-' || moment_number::text), 13, 4) || '-' ||
                    substr(md5('scale-moment-' || moment_number::text), 17, 4) || '-' ||
                    substr(md5('scale-moment-' || moment_number::text), 21, 12)
                )::uuid AS moment_id,
                (
                    substr(md5('scale-revision-' || moment_number::text), 1, 8) || '-' ||
                    substr(md5('scale-revision-' || moment_number::text), 9, 4) || '-' ||
                    substr(md5('scale-revision-' || moment_number::text), 13, 4) || '-' ||
                    substr(md5('scale-revision-' || moment_number::text), 17, 4) || '-' ||
                    substr(md5('scale-revision-' || moment_number::text), 21, 12)
                )::uuid AS revision_id
            FROM generated
        )
        INSERT INTO "TrainingAttempt" (
            "id", "trainingMomentId", "userId", "solutionRevisionId",
            "clientAttemptId", "clientPayloadHash", "attemptedAt",
            "userMoveUci", "status", "grade", "completedAt",
            "contextPhase", "contextCpLoss", "contextWinChanceLoss",
            "contextSourceKinds", "contextProvider", "contextTimeClass",
            "contextConfigHash", "contextSolutionHash"
        )
        SELECT
            attempt_id,
            moment_id,
            ${ids.user}::uuid,
            revision_id,
            'progress-scale-attempt-' || i::text,
            'progress-scale-payload-' || i::text,
            ${asOf} - ((i % 80) * interval '1 day') - ((i % 86400) * interval '1 second'),
            CASE WHEN i % 10 = 0 THEN NULL ELSE 'a1a2' END,
            CASE
                WHEN i % 10 = 0 THEN 'REVEALED'::"AttemptStatus"
                ELSE 'GRADED'::"AttemptStatus"
            END,
            CASE
                WHEN i % 10 = 0 THEN NULL::"AttemptGrade"
                WHEN i % 3 = 0 THEN 'REPEATED_MISTAKE'::"AttemptGrade"
                ELSE 'BEST'::"AttemptGrade"
            END,
            ${asOf} - ((i % 80) * interval '1 day') - ((i % 86400) * interval '1 second'),
            'ENDGAME'::"GamePhase",
            180,
            NULL,
            ARRAY['MY_MISTAKE'::"TrainingSourceKind"],
            'LICHESS'::"GameSource",
            'RAPID'::"TimeClass",
            ${configHash},
            'progress-scale-solution-' || moment_number::text
        FROM identified
    `);
    await db.$executeRawUnsafe('ANALYZE "TrainingAttempt"');
}

function summarizeExplainPlan(plan: unknown) {
    const nodes = new Set<string>();
    const indexes = new Set<string>();
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (typeof record['Node Type'] === 'string') {
            nodes.add(record['Node Type']);
        }
        if (typeof record['Index Name'] === 'string') {
            indexes.add(record['Index Name']);
        }
        Object.values(record).forEach(visit);
    };
    visit(plan);
    return { nodes: [...nodes].sort(), indexes: [...indexes].sort() };
}

function oracle(scope: 90 | 'all') {
    const attempt = (args: {
        id: string;
        completedAt: Date;
        status: 'GRADED' | 'REVEALED';
        grade:
            | 'BEST'
            | 'REPEATED_MISTAKE'
            | null;
        rootGrade: 'BEST' | 'REPEATED_MISTAKE' | null;
    }) => ({
        ...args,
        trainingMomentId: ids.moment,
        solutionRevisionId: ids.revision,
        attemptedAt: args.completedAt,
        userMoveUci:
            args.status === 'REVEALED' ? null : 'a1a2',
        contextPhase: 'ENDGAME' as const,
        contextCpLoss: 180,
        contextWinChanceLoss: null,
        contextSourceKinds: ['MY_MISTAKE' as const],
        contextProvider: 'LICHESS' as const,
        contextTimeClass: 'RAPID' as const,
        contextConfigHash: configHash,
        contextSolutionHash: solutionHash,
        steps:
            args.rootGrade !== null
                ? [
                      {
                          stepIndex: 0,
                          actor: 'USER' as const,
                          moveUci: 'a1a2',
                          grade: args.rootGrade,
                      },
                  ]
                : [],
    });
    return aggregateProgressSnapshot({
        request: {
            scope,
            asOf,
            filters: {
                providers: ['LICHESS'],
                timeClasses: ['RAPID'],
            },
        },
        user: {
            linkedAccounts: { lichess: true, chesscom: false },
            serverCreditsBalance: null,
        },
        games: [
            {
                id: ids.game,
                provider: 'LICHESS',
                timeClass: 'RAPID',
                sourcePgnHash,
                playedAt,
                analyzedAt: new Date('2026-07-01T12:05:00.000Z'),
                currentAnalysisRunId: ids.run,
                currentAnalysisValid: true,
                currentAnalysisRun: {
                    id: ids.run,
                    status: 'SUCCEEDED',
                    inputPgnHash: sourcePgnHash,
                    configHash,
                },
                analysisJob: null,
            },
        ],
        positions: [
            {
                id: ids.moment,
                gameId: ids.game,
                sourcePgnHash,
                originalMoveUci: 'a1a2',
                cpLoss: 180,
                winChanceLoss: null,
                phase: 'ENDGAME',
                status: 'ACTIVE',
                sourceKinds: ['MY_MISTAKE'],
                currentSolutionRevisionId: ids.revision,
                archivedAt: null,
                currentSolutionRevision: {
                    id: ids.revision,
                    solutionHash,
                    configHash,
                    verificationStatus: 'VERIFIED',
                    acceptanceFrontier: { status: 'STABLE' },
                    trainable: true,
                },
                observations: [
                    {
                        analysisRunId: ids.run,
                        solutionRevisionId: ids.revision,
                        observedSolutionHash: solutionHash,
                    },
                ],
            },
        ],
        attempts: [
            attempt({
                id: ids.repeatedOne,
                completedAt: attemptTimes.repeatedOne,
                status: 'GRADED',
                grade: 'REPEATED_MISTAKE',
                rootGrade: 'REPEATED_MISTAKE',
            }),
            attempt({
                id: ids.repeatedTwo,
                completedAt: attemptTimes.repeatedTwo,
                status: 'GRADED',
                grade: 'REPEATED_MISTAKE',
                rootGrade: 'REPEATED_MISTAKE',
            }),
            attempt({
                id: ids.baseline,
                completedAt: attemptTimes.baseline,
                status: 'GRADED',
                grade: 'BEST',
                rootGrade: 'BEST',
            }),
            attempt({
                id: ids.recheck,
                completedAt: attemptTimes.recheck,
                status: 'REVEALED',
                grade: null,
                rootGrade: 'REPEATED_MISTAKE',
            }),
        ],
    });
}

integration('Progress PostgreSQL aggregate reader', () => {
    beforeAll(seedProgressFixture, 60_000);

    afterAll(
        async () => {
            try {
                await db.user.deleteMany({ where: { id: ids.user } });
            } finally {
                await db.$disconnect();
            }
        },
        60_000
    );

    it.each([90 as const, 'all' as const])(
        'matches the pure aggregate oracle for a non-empty %s-day snapshot',
        async (scope) => {
            const actual =
                await progressReadTestUtils.readProgressSnapshot(
                    db,
                    {
                        userId: ids.user,
                        scope,
                        asOf,
                        filters: {
                            providers: ['LICHESS'],
                            timeClasses: ['RAPID'],
                        },
                    },
                    null
                );

            expect(actual).toEqual(oracle(scope));
            expect(actual.inventory).toMatchObject({
                eligiblePositions: 1,
                persistentOriginalMoveRepetition: 1,
            });
            expect(
                actual.actions.needsAnotherLook[0]
                    ?.exactOriginalMoveRepeatCount
            ).toBe(2);
            expect(actual.delayedRecheck).toMatchObject({
                eligibleBaselines: 1,
                observedRechecks: 1,
                observedFullSolve: { x: 0, n: 1 },
            });
        }
    );

    it.runIf(runProgressScaleIntegration)(
        'keeps the real aggregate reader bounded across 100k attempts and 1k positions',
        async () => {
            await seedProgressScaleFixture();

            const startedAt = performance.now();
            const snapshot =
                await progressReadTestUtils.readProgressSnapshot(
                    db,
                    {
                        userId: ids.user,
                        scope: 'all',
                        asOf,
                        filters: {
                            providers: ['LICHESS'],
                            timeClasses: ['RAPID'],
                        },
                    },
                    null
                );
            const readerMs = performance.now() - startedAt;
            const attemptsQuery =
                progressSqlTestUtils.progressAttemptsSummaryQuery({
                    db,
                    userId: ids.user,
                    asOf,
                    from: null,
                    previousFrom: null,
                    previousTo: null,
                    filters: {
                        providers: ['LICHESS'],
                        timeClasses: ['RAPID'],
                    },
                });
            const explainRows = await db.$queryRawUnsafe<
                Array<{ 'QUERY PLAN': unknown }>
            >(
                `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${attemptsQuery.text}`,
                ...attemptsQuery.values
            );
            const plan = explainRows[0]?.['QUERY PLAN'];
            const planSummary = summarizeExplainPlan(plan);
            const explainRoot = Array.isArray(plan)
                ? (plan[0] as Record<string, unknown> | undefined)
                : undefined;
            const attemptsQueryMs = Number(
                explainRoot?.['Execution Time'] ?? Number.NaN
            );

            console.info(
                `Progress scale: ${JSON.stringify({
                    attempts:
                        snapshot.practice.gradedAttempts +
                        snapshot.practice.revealedAttempts,
                    positions: snapshot.inventory.eligiblePositions,
                    readerMs: Math.round(readerMs * 100) / 100,
                    attemptsQueryMs:
                        Math.round(attemptsQueryMs * 100) / 100,
                    ...planSummary,
                })}`
            );
            expect(
                snapshot.practice.gradedAttempts +
                    snapshot.practice.revealedAttempts
            ).toBe(100_003);
            expect(snapshot.inventory.eligiblePositions).toBe(1_001);
            expect(readerMs).toBeLessThan(5_000);
            expect(attemptsQueryMs).toBeLessThan(5_000);
            // EXPLAIN VERBOSE lists every physical table column for a Seq Scan,
            // even when the SQL projection is narrow. Guard the executable
            // query text itself so wide attempt payloads cannot regress here.
            expect(attemptsQuery.text).not.toContain('gradingEvidence');
            expect(attemptsQuery.text).not.toContain('contextThemes');
            expect(attemptsQuery.text).not.toContain(
                'WHERE step."attemptId" = attempt."id"'
            );
        },
        60_000
    );
});
