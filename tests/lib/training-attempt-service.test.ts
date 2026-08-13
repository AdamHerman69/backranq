import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    recordTrainingAttempt,
    trainingAttemptPayloadHash,
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
const afterE4E5 =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const gradingPolicy = {
    version: 3,
    pov: 'TRAINING_SIDE',
    best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
    strong: { maxCpLoss: 50, maxWinChanceLoss: 0.05 },
    success: {
        maxCpLoss: 100,
        maxWinChanceLoss: 0.1,
        preserveOutcome: true,
    },
    improvement: {
        minRecoveredCp: 40,
        minRecoveredWinChance: 0.05,
    },
    unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET',
    matePolicy: 'EXACT',
    tablebasePolicy: 'EXACT',
};

function revisionFixture() {
    return {
        trainable: true,
        verificationStatus: 'VERIFIED',
        acceptanceFrontier: {
            version: 1,
            status: 'STABLE',
            targetCutoffCp: 100,
            effectiveCutoffCp: 80,
            boundaryGapCp: 40,
            moves: [{ moveUci: 'e2e4', tier: 'BEST' }],
            firstRejectedMoveUci: 'a2a3',
        },
        solutionHash: 'solution-hash-1',
        configHash: 'config-hash-1',
        bestMoveUci: 'e2e4',
        acceptedMovesUci: ['e2e4'],
        solutionShape: 'UNIQUE',
        bestLine: ['e2e4'],
        scoreAtStart: { kind: 'cp', cp: 25, pov: 'WHITE' },
        gradingPolicy,
        solutionTree: {
            fen: rootFen,
            ply: 0,
            role: 'USER',
            acceptedMovesUci: ['e2e4'],
            alternativesComplete: true,
            branches: [
                {
                    moveUci: 'e2e4',
                    best: true,
                    child: {
                        fen: afterE4,
                        ply: 1,
                        role: 'TERMINAL',
                        acceptedMovesUci: [],
                        alternativesComplete: true,
                        branches: [],
                    },
                },
            ],
        },
        moveAssessments: [
            {
                decisionIndex: 0,
                fen: rootFen,
                moveUci: 'e2e4',
                source: 'PRECOMPUTED',
                status: 'VERIFIED',
                grade: 'BEST',
                scoreAfter: { kind: 'cp', cp: 25, pov: 'WHITE' },
                evidence: {
                    bestGapCp: 0,
                    bestGapWinChance: 0,
                    recoveredCp: 120,
                    recoveredWinChance: 0.2,
                    preservesOutcome: true,
                },
            },
        ],
    };
}

function momentFixture() {
    return {
        id: momentId,
        fen: rootFen,
        sideToMove: 'w',
        positionHistory: [],
        originalMoveUci: 'd2d4',
        scoreBefore: { kind: 'cp', cp: 25, pov: 'WHITE' },
        scoreAfter: { kind: 'cp', cp: -95, pov: 'WHITE' },
        gameId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        decisionPly: 0,
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
            playedAt: new Date('2026-07-30T08:00:00.000Z'),
        },
        currentSolutionRevision: revisionFixture(),
    };
}

function continuationRevisionFixture() {
    return {
        ...revisionFixture(),
        bestLine: ['e2e4', 'e7e5', 'g1f3'],
        solutionTree: {
            fen: rootFen,
            ply: 0,
            role: 'USER',
            acceptedMovesUci: ['e2e4'],
            alternativesComplete: true,
            branches: [
                {
                    moveUci: 'e2e4',
                    best: true,
                    child: {
                        fen: afterE4,
                        ply: 1,
                        role: 'OPPONENT',
                        acceptedMovesUci: [],
                        selectedMoveUci: 'e7e5',
                        alternativesComplete: true,
                        branches: [
                            {
                                moveUci: 'e7e5',
                                best: true,
                                child: {
                                    fen: afterE4E5,
                                    ply: 2,
                                    role: 'USER',
                                    acceptedMovesUci: ['g1f3'],
                                    alternativesComplete: true,
                                    branches: [
                                        {
                                            moveUci: 'g1f3',
                                            best: true,
                                            child: {
                                                fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
                                                ply: 3,
                                                role: 'TERMINAL',
                                                acceptedMovesUci: [],
                                                branches: [],
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                },
            ],
        },
        moveAssessments: [
            ...revisionFixture().moveAssessments,
            {
                decisionIndex: 1,
                fen: afterE4E5,
                moveUci: 'g1f3',
                source: 'PRECOMPUTED',
                status: 'VERIFIED',
                grade: 'GOOD',
                scoreAfter: {
                    kind: 'cp',
                    cp: 5,
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 20,
                    bestGapWinChance: 0.02,
                    preservesOutcome: true,
                },
            },
        ],
    };
}

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
        $queryRaw: vi.fn().mockResolvedValue([
            {
                acquired: true,
                currentSolutionRevisionId: revisionId,
            },
        ]),
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
            findFirst: vi.fn().mockResolvedValue(momentFixture()),
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
            clientPayloadHash: string;
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

    const moment = momentFixture();

    const createTransactionClient = (
        setRelease: (release: () => void) => void
    ) => ({
        $queryRaw: vi.fn(async () => {
            setRelease(await acquireLock());
            return [
                {
                    acquired: true,
                    currentSolutionRevisionId: revisionId,
                },
            ];
        }),
        trainingAttempt: {
            create: vi.fn(
                async (input: {
                    data: {
                        clientAttemptId: string;
                        trainingMomentId: string;
                        solutionRevisionId: string;
                        clientPayloadHash: string;
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
                        clientPayloadHash:
                            input.data.clientPayloadHash,
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
                clientPayloadHash: expect.any(String),
                gradingEvidence: expect.objectContaining({
                    serverVerified: true,
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

    it('records a reveal after a verified partial continuation', async () => {
        const { db, tx } = dependencies();
        db.trainingMoment.findFirst.mockResolvedValue({
            ...momentFixture(),
            currentSolutionRevision: continuationRevisionFixture(),
        });
        const first = gradedRequest().steps[0]!;

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: {
                    kind: 'RECORD',
                    clientAttemptId,
                    solutionRevisionId: revisionId,
                    status: 'REVEALED',
                    steps: [
                        first,
                        {
                            stepIndex: 1,
                            actor: 'ENGINE',
                            fenBefore: afterE4,
                            moveUci: 'e7e5',
                        },
                    ],
                },
                dependencies: { db: db as never },
            })
        ).resolves.toMatchObject({ status: 'RECORDED' });

        expect(tx.trainingAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                status: 'REVEALED',
                grade: null,
                gradingSource: null,
                userMoveUci: 'e2e4',
            }),
            select: { id: true },
        });
        expect(tx.trainingAttemptStep.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    stepIndex: 0,
                    actor: 'USER',
                    grade: 'BEST',
                }),
                expect.objectContaining({
                    stepIndex: 1,
                    actor: 'ENGINE',
                    grade: null,
                }),
            ],
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

    it('rechecks the current revision under the transaction lock before writing', async () => {
        const { db, tx } = dependencies();
        tx.$queryRaw.mockResolvedValue([
            {
                acquired: true,
                currentSolutionRevisionId:
                    '99999999-9999-4999-8999-999999999999',
            },
        ]);

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: gradedRequest(),
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({
            code: 'STALE_REVISION',
            status: 409,
        });
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
        expect(tx.practiceReviewState.upsert).not.toHaveBeenCalled();
    });

    it('validates the complete local continuation line before writing', async () => {
        const { db, tx } = dependencies();
        db.trainingMoment.findFirst.mockResolvedValue({
            ...momentFixture(),
            currentSolutionRevision: continuationRevisionFixture(),
        });
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
                fenBefore: afterE4E5,
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

    it('aggregates a later tablebase step into the server grading source', async () => {
        const { db, tx } = dependencies();
        const revision = continuationRevisionFixture();
        revision.moveAssessments[1] = {
            ...revision.moveAssessments[1]!,
            source: 'TABLEBASE',
        };
        db.trainingMoment.findFirst.mockResolvedValue({
            ...momentFixture(),
            currentSolutionRevision: revision,
        });
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
                fenBefore: afterE4E5,
                moveUci: 'g1f3',
                grade: 'GOOD',
                source: 'TABLEBASE',
            },
        ];
        request.grade = 'GOOD';
        request.gradingSource = 'TABLEBASE';

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request,
                dependencies: { db: db as never },
            })
        ).resolves.toMatchObject({ status: 'RECORDED' });
        expect(tx.trainingAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                grade: 'GOOD',
                gradingSource: 'TABLEBASE',
            }),
            select: { id: true },
        });
    });

    it('rejects a graded attempt that stops before the solution tree is terminal', async () => {
        const { db, tx } = dependencies();
        db.trainingMoment.findFirst.mockResolvedValue({
            ...momentFixture(),
            currentSolutionRevision: continuationRevisionFixture(),
        });

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: gradedRequest(),
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({
            code: 'INVALID_REQUEST',
            status: 400,
        });
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
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

        const legalButLosing = gradedRequest();
        legalButLosing.steps[0] = {
            ...legalButLosing.steps[0]!,
            moveUci: 'a2a3',
            grade: 'BEST',
        };
        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: legalButLosing,
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
        expect(tx.trainingAttempt.create).not.toHaveBeenCalled();
    });

    it('is idempotent by owner and client attempt id', async () => {
        const { db, tx } = dependencies();
        db.trainingAttempt.findUnique.mockResolvedValue({
            id: 'existing-attempt',
            trainingMomentId: momentId,
            solutionRevisionId: revisionId,
            clientPayloadHash: trainingAttemptPayloadHash({
                momentId,
                request: gradedRequest(),
            }),
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

        await expect(
            recordTrainingAttempt({
                userId: 'user-1',
                momentId,
                request: { ...gradedRequest(), grade: 'GOOD' },
                dependencies: { db: db as never },
            })
        ).rejects.toMatchObject({
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
        });
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
