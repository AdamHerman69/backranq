import { describe, expect, it, vi } from 'vitest';
import {
    PROGRESS_READ_BUDGET,
    ProgressUserNotFoundError,
    progressReadTestUtils,
} from '@/lib/progress/readService';
import type {
    ProgressAttemptsSummary,
    ProgressGamesSummary,
    ProgressPositionsSummary,
} from '@/lib/progress/sqlRead';

const emptyStates = {
    imported: 0,
    analyzed: 0,
    stale: 0,
    queued: 0,
    running: 0,
    failed: 0,
    waiting: 0,
};

function gameSummary(
    overrides: Partial<ProgressGamesSummary> = {}
): ProgressGamesSummary {
    return {
        userExists: true,
        linkedAccounts: { lichess: true, chesscom: false },
        allGames: 0,
        filteredHistoricalGames: 0,
        currentStates: { ...emptyStates },
        previousStates: { ...emptyStates },
        operationalStates: { ...emptyStates },
        currentByProvider: {},
        currentByTimeClass: {},
        waitingForCredits: {
            creditReason: 0,
            creditReasonOrWaiting: 0,
        },
        ...overrides,
    };
}

function positionSummary(
    overrides: Partial<ProgressPositionsSummary> = {}
): ProgressPositionsSummary {
    return {
        currentEligiblePositions: 0,
        currentEligibleGames: 0,
        inventory: {
            eligiblePositions: 0,
            fresh: 0,
            needsAnotherLook: 0,
            persistentOriginalMoveRepetition: 0,
        },
        actions: {
            needsAnotherLook: [],
            persistentOriginalMoveRepetition: [],
        },
        impact: {
            winningChance: {},
            centipawnFallback: {},
            unknown: 0,
        },
        breakdowns: {},
        ...overrides,
    };
}

function attemptSummary(
    overrides: Partial<ProgressAttemptsSummary> = {}
): ProgressAttemptsSummary {
    return {
        filteredHistoricalAttempts: 0,
        filteredCurrentAttempts: 0,
        unfilteredCurrentAttempts: 0,
        currentByProvider: {},
        currentByTimeClass: {},
        currentPractice: {
            graded: 0,
            revealed: 0,
            unresolved: 0,
            solved: 0,
            rootObserved: 0,
            rootSolved: 0,
            rootRepeated: 0,
            gradeCounts: {},
        },
        previousPractice: { graded: 0, solved: 0 },
        firstOutcome: {
            positions: 0,
            graded: 0,
            revealed: 0,
            solved: 0,
            gradeCounts: {},
        },
        delayedRecheck: {
            eligibleBaselines: 0,
            observedRechecks: 0,
            observedSolved: 0,
        },
        currentConfig: [],
        previousConfig: [],
        currentMix: {},
        previousMix: {},
        breakdowns: {},
        ...overrides,
    };
}

function reader(overrides?: {
    games?: ProgressGamesSummary;
    positions?: ProgressPositionsSummary;
    attempts?: ProgressAttemptsSummary;
}) {
    const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
            { payload: overrides?.games ?? gameSummary() },
        ])
        .mockResolvedValueOnce([
            {
                payload:
                    overrides?.positions ?? positionSummary(),
            },
        ])
        .mockResolvedValueOnce([
            {
                payload:
                    overrides?.attempts ?? attemptSummary(),
            },
        ]);
    return {
        db: {
            $queryRaw: queryRaw,
        } as never,
        queryRaw,
    };
}

const request = {
    userId: '10000000-0000-4000-8000-000000000001',
    scope: 90 as const,
    asOf: new Date('2026-07-01T00:00:00.000Z'),
    filters: { providers: [], timeClasses: [] },
};

describe('Progress SQL read service', () => {
    it('uses three bounded operations and never returns source entity rows', async () => {
        const { db, queryRaw } = reader();

        const snapshot =
            await progressReadTestUtils.readProgressSnapshot(
                db,
                request,
                7
            );

        expect(queryRaw).toHaveBeenCalledTimes(3);
        expect(queryRaw.mock.calls.length).toBeLessThanOrEqual(
            PROGRESS_READ_BUDGET.databaseOperations
        );
        expect(PROGRESS_READ_BUDGET).toMatchObject({
            materializedGames: 0,
            materializedPositions: 0,
            materializedAttempts: 0,
            actionsPerList: 20,
        });
        expect(snapshot.operational).toMatchObject({
            linkedAccounts: { lichess: true, chesscom: false },
            serverCreditsBalance: 7,
            primaryState: 'NO_GAMES',
        });

        const sql = queryRaw.mock.calls
            .map(([query]) => (query as { sql: string }).sql)
            .join('\n');
        const attemptsSql = (
            queryRaw.mock.calls[2]?.[0] as { sql: string }
        ).sql;
        expect(sql).toContain('WITH games AS MATERIALIZED');
        expect(sql).toContain('WITH eligible AS MATERIALIZED');
        expect(sql).toContain('WITH attempts AS MATERIALIZED');
        expect(attemptsSql).not.toContain('attempt.*');
        expect(attemptsSql).not.toContain('attempt."gradingEvidence"');
        expect(attemptsSql).not.toContain('attempt."contextThemes"');
        expect(sql).toContain('LIMIT 20');
        expect(sql).not.toContain('LIMIT 25001');
        expect(sql).not.toContain('LIMIT 100001');
    });

    it('handles million-row source volumes as aggregate counts instead of failing closed', async () => {
        const million = 1_000_000;
        const { db } = reader({
            games: gameSummary({
                allGames: million,
                filteredHistoricalGames: million,
                currentStates: {
                    ...emptyStates,
                    imported: million,
                    analyzed: million,
                },
                operationalStates: {
                    ...emptyStates,
                    imported: million,
                    analyzed: million,
                },
                currentByProvider: { LICHESS: million },
                currentByTimeClass: { RAPID: million },
            }),
            positions: positionSummary({
                currentEligiblePositions: million,
                currentEligibleGames: million,
                inventory: {
                    eligiblePositions: million,
                    fresh: million,
                    needsAnotherLook: 0,
                    persistentOriginalMoveRepetition: 0,
                },
            }),
        });

        const snapshot =
            await progressReadTestUtils.readProgressSnapshot(
                db,
                request,
                null
            );

        expect(snapshot.coverage).toMatchObject({
            eligiblePositions: million,
            analysisStates: {
                imported: million,
                analyzed: million,
            },
        });
        expect(snapshot.inventory).toMatchObject({
            eligiblePositions: million,
            fresh: million,
        });
    });

    it('fails with the user contract after the parallel aggregates settle', async () => {
        const { db, queryRaw } = reader({
            games: gameSummary({ userExists: false }),
        });

        await expect(
            progressReadTestUtils.readProgressSnapshot(
                db,
                request,
                null
            )
        ).rejects.toBeInstanceOf(ProgressUserNotFoundError);
        expect(queryRaw).toHaveBeenCalledTimes(3);
    });
});
