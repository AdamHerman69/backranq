import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    recordTrainingAttempt,
    TrainingAttemptError,
} from '@/lib/training/attemptService';
import type { RecordTrainingAttemptRequest } from '@/lib/training/api';

const momentId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const clientAttemptId =
    '33333333-3333-4333-8333-333333333333';
const rootFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const afterE4 =
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function gradedRequest(): RecordTrainingAttemptRequest {
    return {
        kind: 'RECORD',
        clientAttemptId,
        solutionRevisionId: revisionId,
        status: 'GRADED',
        grade: 'BEST',
        gradingSource: 'PRECOMPUTED',
        comparison: {
            submittedScoreAfter: {
                kind: 'cp',
                cp: 25,
                pov: 'WHITE',
            },
            bestGapCp: 0,
            bestGapWinChance: 0,
            recoveredCp: 120,
            recoveredWinChance: 0.2,
            preservesOutcome: true,
        },
        steps: [
            {
                stepIndex: 0,
                actor: 'USER',
                fenBefore: rootFen,
                moveUci: 'e2e4',
                grade: 'BEST',
                source: 'PRECOMPUTED',
                timeSpentMs: 900,
            },
        ],
    };
}

function dependencies() {
    const created = {
        id: '44444444-4444-4444-8444-444444444444',
    };
    const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
        trainingAttempt: {
            create: vi.fn().mockResolvedValue(created),
        },
        trainingAttemptStep: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        trainingMoment: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        trainingAttemptStatusEvent: {
            create: vi.fn().mockResolvedValue({ id: 'status-event-1' }),
        },
        practiceReviewState: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({ id: 'review-state-1' }),
        },
        practiceReviewEvent: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'review-event-1' }),
        },
    };
    const db = {
        trainingAttempt: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
        trainingMoment: {
            findFirst: vi.fn().mockResolvedValue({
                id: momentId,
                fen: rootFen,
                phase: 'MIDDLEGAME',
                cpLoss: 120,
                winChanceLoss: 0.2,
                sourceKinds: ['MY_MISTAKE'],
                lessonKinds: ['TACTICAL'],
                themes: ['fork'],
                currentSolutionRevisionId: revisionId,
                game: {
                    provider: 'LICHESS',
                    timeClass: 'RAPID',
                },
                currentSolutionRevision: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
                    acceptanceFrontier: { status: 'STABLE' },
                    solutionHash: 'solution-hash-1',
                    configHash: 'config-hash-1',
                },
            }),
        },
        $transaction: vi.fn(
            async (callback: (transaction: typeof tx) => unknown) =>
                callback(tx)
        ),
    };
    return { db, tx, created };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

type ReviewStateSnapshot = {
    id: string;
    intervalDays: number;
    lapses: number;
    successes: number;
    nextDueAt: Date;
    lastReviewedAt: Date;
    algorithmVersion: string;
};

type ReviewStateWrite = Omit<ReviewStateSnapshot, 'id'>;

function concurrentDependencies() {
    const attempts = new Map<
        string,
        {
            id: string;
            trainingMomentId: string;
            solutionRevisionId: string;
        }
    >();
    const reviewEventKeys = new Set<string>();
    let reviewState: ReviewStateSnapshot | null = null;
    let lastTrainedAt: Date | null = null;
    let createdAttemptCount = 0;

    const firstLockAcquired = deferred();
    const allowFirstLock = deferred();
    const secondLockWaiting = deferred();
    const lockWaiters: Array<() => void> = [];
    let lockHeld = false;
    let lockAcquisitions = 0;

    const releaseLock = () => {
        const next = lockWaiters.shift();
        if (next) next();
        else lockHeld = false;
    };
    const acquireLock = async () => {
        if (lockHeld) {
            secondLockWaiting.resolve();
            await new Promise<void>((resolve) => {
                lockWaiters.push(resolve);
            });
        } else {
            lockHeld = true;
        }
        lockAcquisitions += 1;
        if (lockAcquisitions === 1) {
            firstLockAcquired.resolve();
            await allowFirstLock.promise;
        }
        return releaseLock;
    };

    const moment = {
        id: momentId,
        fen: rootFen,
        phase: 'MIDDLEGAME',
        cpLoss: 120,
        winChanceLoss: 0.2,
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['TACTICAL'],
        themes: ['fork'],
        currentSolutionRevisionId: revisionId,
        game: {
            provider: 'LICHESS',
            timeClass: 'RAPID',
        },
        currentSolutionRevision: {
            trainable: true,
            verificationStatus: 'VERIFIED',
            acceptanceFrontier: { status: 'STABLE' },
            solutionHash: 'solution-hash-1',
            configHash: 'config-hash-1',
        },
    };

    const createTransactionClient = (
        setRelease: (release: () => void) => void
    ) => ({
        $queryRaw: vi.fn(async () => {
            setRelease(await acquireLock());
            return [{ acquired: true }];
        }),
        trainingAttempt: {
            create: vi.fn(
                async (input: {
                    data: {
                        clientAttemptId: string;
                        trainingMomentId: string;
                        solutionRevisionId: string;
                    };
                }) => {
                    if (attempts.has(input.data.clientAttemptId)) {
                        throw { code: 'P2002' };
                    }
                    createdAttemptCount += 1;
                    const created = {
                        id: `attempt-${createdAttemptCount}`,
                        trainingMomentId:
                            input.data.trainingMomentId,
                        solutionRevisionId:
                            input.data.solutionRevisionId,
                    };
                    attempts.set(input.data.clientAttemptId, created);
                    return { id: created.id };
                }
            ),
        },
        trainingAttemptStep: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        trainingMoment: {
            updateMany: vi.fn(
                async (input: { data: { lastTrainedAt: Date } }) => {
                    if (
                        !lastTrainedAt ||
                        input.data.lastTrainedAt > lastTrainedAt
                    ) {
                        lastTrainedAt = input.data.lastTrainedAt;
                        return { count: 1 };
                    }
                    return { count: 0 };
                }
            ),
        },
        trainingAttemptStatusEvent: {
            create: vi.fn().mockResolvedValue({ id: 'status-event' }),
        },
        practiceReviewState: {
            findUnique: vi.fn(async () =>
                reviewState ? { ...reviewState } : null
            ),
            upsert: vi.fn(
                async (input: {
                    create: ReviewStateWrite;
                    update: ReviewStateWrite;
                }) => {
                    const write = reviewState
                        ? input.update
                        : input.create;
                    reviewState = {
                        id: reviewState?.id ?? 'review-state-1',
                        intervalDays: write.intervalDays,
                        lapses: write.lapses,
                        successes: write.successes,
                        nextDueAt: write.nextDueAt,
                        lastReviewedAt: write.lastReviewedAt,
                        algorithmVersion: write.algorithmVersion,
                    };
                    return { id: reviewState.id };
                }
            ),
        },
        practiceReviewEvent: {
            findUnique: vi.fn(
                async (input: {
                    where: {
                        userId_eventKey: { eventKey: string };
                    };
                }) =>
                    reviewEventKeys.has(
                        input.where.userId_eventKey.eventKey
                    )
                        ? { id: 'existing-review-event' }
                        : null
            ),
            create: vi.fn(
                async (input: { data: { eventKey: string } }) => {
                    reviewEventKeys.add(input.data.eventKey);
                    return { id: `review-event-${reviewEventKeys.size}` };
                }
            ),
        },
    });

    const db = {
        trainingAttempt: {
            findUnique: vi.fn(
                async (input: {
                    where: {
                        userId_clientAttemptId: {
                            clientAttemptId: string;
                        };
                    };
                }) =>
                    attempts.get(
                        input.where.userId_clientAttemptId
                            .clientAttemptId
                    ) ?? null
            ),
        },
        trainingMoment: {
            findFirst: vi.fn().mockResolvedValue(moment),
        },
        $transaction: vi.fn(
            async (
                callback: (
                    tx: ReturnType<typeof createTransactionClient>
                ) => Promise<unknown>
            ) => {
                const lock: { release: (() => void) | null } = {
                    release: null,
                };
                const tx = createTransactionClient((value) => {
                    lock.release = value;
                });
                try {
                    return await callback(tx);
                } finally {
                    lock.release?.();
                }
            }
        ),
    };

    return {
        db,
        firstLockAcquired,
        allowFirstLock,
        secondLockWaiting,
        state: () => reviewState,
        eventCount: () => reviewEventKeys.size,
        lastTrainedAt: () => lastTrainedAt,
    };
}

describe('client-graded training attempt recording', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('persists a completed local result without invoking an engine', async () => {
        const { db, tx, created } = dependencies();
        const response = await recordTrainingAttempt({
            userId: 'user-1',
            momentId,
            request: gradedRequest(),
            dependencies: {
                db: db as never,
                now: () => new Date('2026-07-30T08:00:00.000Z'),
            },
        });

        expect(response).toEqual({
            attemptId: created.id,
            status: 'RECORDED',
        });
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(
            tx.$queryRaw.mock.invocationCallOrder[0]
        ).toBeLessThan(
            tx.trainingAttempt.create.mock.invocationCallOrder[0] ??
                Number.MAX_SAFE_INTEGER
        );
        const lockSql = Array.isArray(tx.$queryRaw.mock.calls[0]?.[0])
            ? tx.$queryRaw.mock.calls[0]![0].join(' ')
            : String(tx.$queryRaw.mock.calls[0]?.[0]);
        expect(lockSql).toContain('pg_advisory_xact_lock');
        expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe(
            `practice-review:user-1:${momentId}`
        );
        expect(tx.trainingAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                status: 'GRADED',
                grade: 'BEST',
                gradingSource: 'PRECOMPUTED',
                userMoveUci: 'e2e4',
                gradingEvidence: expect.objectContaining({
                    clientGraded: true,
                }),
                contextPhase: 'MIDDLEGAME',
                contextCpLoss: 120,
                contextWinChanceLoss: 0.2,
                contextSourceKinds: ['MY_MISTAKE'],
                contextLessonKinds: ['TACTICAL'],
                contextThemes: ['fork'],
                contextProvider: 'LICHESS',
                contextTimeClass: 'RAPID',
                contextSolutionHash: 'solution-hash-1',
                contextConfigHash: 'config-hash-1',
            }),
            select: { id: true },
        });
        expect(tx.trainingAttemptStep.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    stepIndex: 0,
                    actor: 'USER',
                    fenBefore: rootFen,
                    moveUci: 'e2e4',
                    grade: 'BEST',
                }),
            ],
        });
        expect(tx.trainingMoment.updateMany).toHaveBeenCalled();
        expect(
            tx.trainingAttemptStatusEvent.create
        ).toHaveBeenCalledWith({
            data: expect.objectContaining({
                attemptId: created.id,
                status: 'GRADED',
                grade: 'BEST',
                reason: 'GRADED',
            }),
        });
        expect(tx.practiceReviewState.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    solutionHash: 'solution-hash-1',
                    configHash: 'config-hash-1',
                    successes: 1,
                }),
            })
        );
        expect(tx.practiceReviewEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                attemptId: created.id,
                outcome: 'SUCCESS',
                grade: 'BEST',
            }),
        });
    });

    it('records reveal-only history without requiring a move', async () => {
        const { db, tx } = dependencies();
        await recordTrainingAttempt({
            userId: 'user-1',
            momentId,
            request: {
                kind: 'RECORD',
                clientAttemptId,
                solutionRevisionId: revisionId,
                status: 'REVEALED',
                steps: [],
            },
            dependencies: { db: db as never },
        });

        expect(tx.trainingAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                status: 'REVEALED',
                grade: null,
                gradingSource: null,
                userMoveUci: null,
            }),
            select: { id: true },
        });
        expect(
            tx.trainingAttemptStep.createMany
        ).not.toHaveBeenCalled();
        expect(
            tx.trainingAttemptStatusEvent.create
        ).toHaveBeenCalledWith({
            data: expect.objectContaining({
                status: 'REVEALED',
                grade: null,
                reason: 'REVEALED',
            }),
        });
        expect(tx.practiceReviewEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                outcome: 'REVEAL',
                grade: null,
            }),
        });
    });

    it('rejects a verified revision whose acceptance frontier is not stable', async () => {
        const { db, tx } = dependencies();
        const moment = await db.trainingMoment.findFirst();
        db.trainingMoment.findFirst.mockResolvedValue({
            ...moment,
            currentSolutionRevision: {
                ...moment.currentSolutionRevision,
                acceptanceFrontier: { status: 'OPEN' },
            },
        });

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: gradedRequest(),
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
    });

    it('validates the complete local continuation line before writing', async () => {
        const { db, tx } = dependencies();
        const request = gradedRequest();
        request.steps = [
            request.steps[0]!,
            {
                stepIndex: 1,
                actor: 'ENGINE',
                fenBefore: afterE4,
                moveUci: 'e7e5',
            },
            {
                stepIndex: 2,
                actor: 'USER',
                fenBefore:
                    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
                moveUci: 'g1f3',
                grade: 'GOOD',
                source: 'PRECOMPUTED',
            },
        ];
        request.grade = 'GOOD';

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request,
                dependencies: { db: db as never },
            })
        ).resolves.toMatchObject({ status: 'RECORDED' });
        expect(tx.trainingAttemptStep.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
                expect.objectContaining({
                    stepIndex: 1,
                    actor: 'ENGINE',
                    grade: null,
                }),
            ]),
        });
    });

    it('rejects illegal, discontinuous, and forged aggregate results', async () => {
        const { db, tx } = dependencies();
        const illegal = gradedRequest();
        illegal.steps[0] = {
            ...illegal.steps[0]!,
            moveUci: 'e2e5',
        };
        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: illegal,
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({
            code: 'ILLEGAL_MOVE',
            status: 400,
        });

        const forged = gradedRequest();
        forged.grade = 'GOOD';
        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: forged,
                dependencies: { db: db as never },
            })
        ).rejects.toBeInstanceOf(TrainingAttemptError);
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
    });

    it('is idempotent by owner and client attempt id', async () => {
        const { db, tx } = dependencies();
        db.trainingAttempt.findUnique.mockResolvedValue({
            id: 'existing-attempt',
            trainingMomentId: momentId,
            solutionRevisionId: revisionId,
        });

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: gradedRequest(),
                dependencies: { db: db as never },
            })
        ).resolves.toEqual({
            attemptId: 'existing-attempt',
            status: 'RECORDED',
        });
        expect(db.trainingMoment.findFirst).not.toHaveBeenCalled();
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
        expect(
            tx.trainingAttemptStatusEvent.create
        ).not.toHaveBeenCalled();
    });

    it('serializes distinct attempts and preserves the newer schedule when timestamps arrive out of order', async () => {
        const harness = concurrentDependencies();
        const newerAt = new Date('2026-08-04T12:00:00.000Z');
        const olderAt = new Date('2026-08-03T12:00:00.000Z');
        const newerRequest = {
            ...gradedRequest(),
            clientAttemptId:
                '44444444-4444-4444-8444-444444444444',
        };
        const olderRequest = {
            ...gradedRequest(),
            clientAttemptId:
                '55555555-5555-4555-8555-555555555555',
        };

        const newer = recordTrainingAttempt({
            userId: 'user-1',
            momentId,
            request: newerRequest,
            dependencies: {
                db: harness.db as never,
                now: () => newerAt,
            },
        });
        await harness.firstLockAcquired.promise;
        const older = recordTrainingAttempt({
            userId: 'user-1',
            momentId,
            request: olderRequest,
            dependencies: {
                db: harness.db as never,
                now: () => olderAt,
            },
        });
        await harness.secondLockWaiting.promise;
        harness.allowFirstLock.resolve();

        const results = await Promise.all([newer, older]);
        expect(results[0].attemptId).not.toBe(results[1].attemptId);
        expect(harness.eventCount()).toBe(2);
        expect(harness.state()).toMatchObject({
            successes: 2,
            lapses: 0,
            intervalDays: 1,
            lastReviewedAt: newerAt,
            nextDueAt: new Date('2026-08-05T12:00:00.000Z'),
        });
        expect(harness.lastTrainedAt()).toEqual(newerAt);

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: newerRequest,
                dependencies: {
                    db: harness.db as never,
                    now: () => newerAt,
                },
            })
        ).resolves.toEqual(results[0]);
        expect(harness.eventCount()).toBe(2);
        expect(harness.state()).toMatchObject({ successes: 2 });
    });
});
