import { describe, expect, it, vi } from 'vitest';
import {
    PROGRESS_READ_LIMITS,
    ProgressDatasetTooLargeError,
    progressReadTestUtils,
} from '@/lib/progress/readService';

describe('Progress read service query shape', () => {
    it('loads only active current candidates and bounded terminal evidence', async () => {
        const userFindUnique = vi.fn().mockResolvedValue({
            chessAccountConnections: [{ provider: 'LICHESS' }],
            billingAccount: {
                serverCreditsBalance: 7,
            },
        });
        const gameFindMany = vi.fn().mockResolvedValue([]);
        const positionFindMany = vi.fn().mockResolvedValue([]);
        const attemptFindMany = vi.fn().mockResolvedValue([]);
        const asOf = new Date('2026-07-01T00:00:00.000Z');

        await progressReadTestUtils.readProgressSnapshot(
            {
                user: { findUnique: userFindUnique },
                analyzedGame: { findMany: gameFindMany },
                trainingMoment: { findMany: positionFindMany },
                trainingAttempt: { findMany: attemptFindMany },
            } as never,
            {
                userId: 'user-1',
                scope: 90,
                asOf,
                filters: { providers: [], timeClasses: [] },
            },
            7
        );

        expect(positionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: 'user-1',
                    status: 'ACTIVE',
                    archivedAt: null,
                    currentSolutionRevisionId: { not: null },
                    currentSolutionRevision: {
                        is: {
                            trainable: true,
                            verificationStatus: {
                                in: ['VERIFIED', 'AMBIGUOUS'],
                            },
                        },
                    },
                }),
                select: expect.not.objectContaining({
                    attempts: expect.anything(),
                }),
                take: PROGRESS_READ_LIMITS.positions + 1,
            })
        );
        expect(attemptFindMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                completedAt: {
                    not: null,
                    lte: asOf,
                },
                status: {
                    in: ['GRADED', 'REVEALED', 'UNRESOLVED'],
                },
            },
            select: expect.objectContaining({
                trainingMomentId: true,
                contextPhase: true,
                contextCpLoss: true,
                contextWinChanceLoss: true,
                contextSourceKinds: true,
                contextProvider: true,
                contextTimeClass: true,
                contextConfigHash: true,
                contextSolutionHash: true,
                steps: expect.objectContaining({
                    where: { actor: 'USER' },
                    orderBy: { stepIndex: 'asc' },
                    take: 1,
                }),
            }),
            take: PROGRESS_READ_LIMITS.attempts + 1,
        });

        const gameQuery = gameFindMany.mock.calls[0][0];
        expect(gameQuery.take).toBe(
            PROGRESS_READ_LIMITS.games + 1
        );
        expect(gameQuery.select.sourcePgnHash).toBe(true);
        expect(gameQuery.select).not.toHaveProperty('pgn');
        expect(
            positionFindMany.mock.calls[0][0].select
                .observations
        ).toMatchObject({
            orderBy: { createdAt: 'desc' },
            take: PROGRESS_READ_LIMITS.observationsPerPosition,
        });
    });

    it('keeps archived Position history because attempts are read independently', async () => {
        const completedAt = new Date(
            '2026-06-30T00:00:00.000Z'
        );
        const result =
            await progressReadTestUtils.readProgressSnapshot(
                {
                    user: {
                        findUnique: vi.fn().mockResolvedValue({
                            chessAccountConnections: [{ provider: 'LICHESS' }],
                            billingAccount: null,
                        }),
                    },
                    analyzedGame: {
                        findMany: vi.fn().mockResolvedValue([]),
                    },
                    // The source Position has been archived by reanalysis
                    // and is intentionally absent from current inventory.
                    trainingMoment: {
                        findMany: vi.fn().mockResolvedValue([]),
                    },
                    trainingAttempt: {
                        findMany: vi.fn().mockResolvedValue([
                            {
                                id: 'attempt-1',
                                trainingMomentId:
                                    'archived-position',
                                solutionRevisionId:
                                    'old-revision',
                                attemptedAt: completedAt,
                                completedAt,
                                userMoveUci: 'e2e4',
                                status: 'GRADED',
                                grade: 'BEST',
                                contextPhase: 'OPENING',
                                contextCpLoss: 160,
                                contextWinChanceLoss: null,
                                contextSourceKinds: [
                                    'MY_MISTAKE',
                                ],
                                contextProvider: 'LICHESS',
                                contextTimeClass: 'RAPID',
                                contextConfigHash: 'config-old',
                                contextSolutionHash:
                                    'solution-old',
                                steps: [
                                    {
                                        stepIndex: 0,
                                        actor: 'USER',
                                        moveUci: 'e2e4',
                                        grade: 'BEST',
                                    },
                                ],
                            },
                        ]),
                    },
                } as never,
                {
                    userId: 'user-1',
                    scope: 90,
                    asOf: new Date(
                        '2026-07-01T00:00:00.000Z'
                    ),
                    filters: {
                        providers: [],
                        timeClasses: [],
                    },
                },
                null
            );

        expect(result.inventory.eligiblePositions).toBe(0);
        expect(result.practice).toMatchObject({
            gradedAttempts: 1,
            fullPositionSolve: { x: 1, n: 1 },
        });
    });

    it('fails closed instead of returning a truncated snapshot', async () => {
        const tooManyGames = Array.from(
            { length: PROGRESS_READ_LIMITS.games + 1 },
            () => ({})
        );

        await expect(
            progressReadTestUtils.readProgressSnapshot(
                {
                    user: {
                        findUnique: vi.fn().mockResolvedValue({
                            chessAccountConnections: [{ provider: 'LICHESS' }],
                            billingAccount: null,
                        }),
                    },
                    analyzedGame: {
                        findMany: vi
                            .fn()
                            .mockResolvedValue(tooManyGames),
                    },
                    trainingMoment: {
                        findMany: vi.fn().mockResolvedValue([]),
                    },
                    trainingAttempt: {
                        findMany: vi.fn().mockResolvedValue([]),
                    },
                } as never,
                {
                    userId: 'user-1',
                    scope: 90,
                    asOf: new Date(
                        '2026-07-01T00:00:00.000Z'
                    ),
                    filters: {
                        providers: [],
                        timeClasses: [],
                    },
                },
                null
            )
        ).rejects.toEqual(
            new ProgressDatasetTooLargeError('games')
        );
    });
});
