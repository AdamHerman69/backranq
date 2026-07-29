import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import {
    revealTrainingMoment,
    submitTrainingAttempt,
    TrainingAttemptError,
} from '@/lib/training/attemptService';
import { normalizeGradingPolicy } from '@/lib/training/config';
import type { TrainingMoveMetrics } from '@/lib/training/grader';
import { assessmentPositionKey } from '@/lib/training/assessmentIdentity';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const momentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const revisionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const clientAttemptId =
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const rootAssessmentKey = assessmentPositionKey(fen, []);

const revision = {
    id: revisionId,
    momentId,
    verificationStatus: 'VERIFIED',
    trainable: true,
    continuationShape: 'SINGLE_DECISION',
    solutionShape: 'UNIQUE',
    bestMoveUci: 'e2e4',
    acceptedMovesUci: ['e2e4'],
    bestLine: ['e2e4', 'e7e5'],
    solutionTree: {
        fen,
        ply: 0,
        role: 'USER',
        branches: [
            {
                moveUci: 'e2e4',
                best: true,
                child: {
                    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                    ply: 1,
                    role: 'TERMINAL',
                    branches: [],
                },
            },
        ],
    },
    scoreAtStart: { kind: 'cp', cp: 50, pov: 'WHITE' },
    playedMoveScore: { kind: 'cp', cp: -100, pov: 'WHITE' },
    gradingPolicy: normalizeGradingPolicy(undefined, 'PRACTICAL'),
};

const moment = {
    id: momentId,
    userId,
    gameId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    decisionPly: 0,
    fen,
    positionHistory: [],
    sideToMove: 'w',
    originalMoveUci: 'a2a3',
    scoreBefore: { kind: 'cp', cp: 50, pov: 'WHITE' },
    scoreAfter: { kind: 'cp', cp: -100, pov: 'WHITE' },
    cpLoss: 150,
    winChanceLoss: 0.2,
    sourceKinds: ['MY_MISTAKE'],
    lessonKinds: ['AVOID_MISTAKE'],
    themes: ['development'],
    currentSolutionRevisionId: revisionId,
    game: {
        provider: 'LICHESS',
        playedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    currentSolutionRevision: revision,
};

type AssessmentState = {
    id: string;
    solutionRevisionId: string;
    positionKey: string;
    decisionIndex: number;
    fen: string;
    moveUci: string;
    source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
    status: 'PENDING' | 'VERIFIED' | 'FAILED';
    grade:
        | 'BEST'
        | 'GOOD'
        | 'IMPROVED'
        | 'REPEATED_MISTAKE'
        | 'DIFFERENT_MISTAKE'
        | null;
    scoreAfter: unknown;
    evidence: unknown;
    attempts: number;
    lockedAt: Date | null;
    lockedUntil: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function createDb(
    options: {
        assessment?: AssessmentState | null;
        trainingMoment?: Record<string, unknown>;
        initialAttempt?: Record<string, unknown>;
    } = {}
) {
    let attempt: Record<string, unknown> | null =
        options.initialAttempt ?? null;
    const steps: Array<Record<string, unknown>> =
        attempt && Array.isArray(attempt.steps)
            ? (attempt.steps as Array<Record<string, unknown>>)
            : [];
    if (attempt) attempt.steps = steps;
    let assessment = options.assessment ?? null;
    const trainingMoment = options.trainingMoment ?? moment;
    const now = new Date('2026-01-01T00:00:00.000Z');

    const trainingAttempt = {
        findUnique: vi.fn(
            async ({
                where,
            }: {
                where?: {
                    userId_clientAttemptId?: {
                        clientAttemptId: string;
                    };
                };
            } = {}) =>
                attempt &&
                (!where?.userId_clientAttemptId ||
                    where.userId_clientAttemptId.clientAttemptId ===
                        attempt.clientAttemptId)
                    ? attempt
                    : null
        ),
        findFirst: vi.fn(async () =>
            attempt ? { ...attempt, steps: steps.map((step) => ({ ...step })) } : null
        ),
        create: vi.fn(
            async ({
                data,
            }: {
                data: Record<string, unknown>;
            }) => {
            attempt = {
                id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                attemptedAt: now,
                grade: null,
                gradingSource: null,
                gradingEvidence: {},
                bestGapCp: null,
                bestGapWinChance: null,
                recoveredCp: null,
                recoveredWinChance: null,
                completedAt: null,
                ...data,
                trainingMoment,
                solutionRevision:
                    trainingMoment.currentSolutionRevision ??
                    revision,
                steps,
            };
            return attempt;
            }
        ),
        count: vi.fn(async () => 0),
        updateMany: vi.fn(async ({
            where,
            data,
        }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => {
            if (!attempt || (where.id && where.id !== attempt.id)) {
                return { count: 0 };
            }
            if (where.status && where.status !== attempt.status) {
                return { count: 0 };
            }
            if (
                typeof where.attemptedAt === 'object' &&
                where.attemptedAt !== null &&
                'lte' in where.attemptedAt &&
                where.attemptedAt.lte instanceof Date &&
                attempt.attemptedAt instanceof Date &&
                attempt.attemptedAt > where.attemptedAt.lte
            ) {
                return { count: 0 };
            }
            for (const [key, value] of Object.entries(data)) {
                if (
                    value &&
                    typeof value === 'object' &&
                    'increment' in value
                ) {
                    attempt[key] =
                        Number(attempt[key] ?? 0) +
                        Number((value as { increment: number }).increment);
                } else {
                    attempt[key] = value;
                }
            }
            return { count: 1 };
        }),
    };
    const trainingAttemptStep = {
        findUnique: vi.fn(
            async ({
                where,
            }: {
                where: {
                    attemptId_stepIndex: {
                        attemptId: string;
                        stepIndex: number;
                    };
                };
            }) =>
                steps.find(
                    (step) =>
                        step.attemptId ===
                            where.attemptId_stepIndex.attemptId &&
                        step.stepIndex ===
                            where.attemptId_stepIndex.stepIndex
                ) ?? null
        ),
        create: vi.fn(async ({
            data,
        }: {
            data: Record<string, unknown>;
        }) => {
            const step = {
                id: `step-${data.stepIndex}`,
                grade: null,
                timeSpentMs: null,
                ...data,
            };
            steps.push(step);
            return step;
        }),
        updateMany: vi.fn(async ({
            where,
            data,
        }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => {
            const step = steps.find((item) => item.id === where.id);
            if (!step || (where.grade === null && step.grade !== null)) {
                return { count: 0 };
            }
            Object.assign(step, data);
            return { count: 1 };
        }),
    };
    const solutionMoveAssessment = {
        findUnique: vi.fn(async () => assessment),
        findFirst: vi.fn(async () =>
            assessment?.grade === 'BEST' ? assessment : null
        ),
        create: vi.fn(async ({
            data,
        }: {
            data: Partial<AssessmentState>;
        }) => {
            assessment = {
                id: 'assessment-1',
                scoreAfter: null,
                grade: null,
                lastError: null,
                createdAt: now,
                updatedAt: now,
                ...data,
            } as AssessmentState;
            return assessment;
        }),
        updateMany: vi.fn(async ({
            where,
            data,
        }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => {
            if (!assessment || (where.id && where.id !== assessment.id)) {
                return { count: 0 };
            }
            if (where.status) {
                const statusFilter =
                    typeof where.status === 'object' &&
                    where.status !== null &&
                    'in' in where.status
                        ? (where.status as { in: unknown }).in
                        : where.status;
                const allowed = Array.isArray(statusFilter)
                    ? statusFilter
                    : [statusFilter];
                if (!allowed.includes(assessment.status)) {
                    return { count: 0 };
                }
            }
            if (
                where.attempts !== undefined &&
                where.attempts !== assessment.attempts
            ) {
                return { count: 0 };
            }
            if (
                where.lockedAt instanceof Date &&
                assessment.lockedAt?.getTime() !==
                    where.lockedAt.getTime()
            ) {
                return { count: 0 };
            }
            if (where.OR && assessment.lockedUntil && assessment.lockedUntil > now) {
                return { count: 0 };
            }
            const mutableAssessment = assessment as unknown as Record<
                string,
                unknown
            >;
            for (const [key, value] of Object.entries(data)) {
                if (
                    value &&
                    typeof value === 'object' &&
                    'increment' in value
                ) {
                    mutableAssessment[key] =
                        Number(mutableAssessment[key] ?? 0) +
                        Number((value as { increment: number }).increment);
                } else {
                    mutableAssessment[key] = value;
                }
            }
            return { count: 1 };
        }),
    };
    const rawDb: Record<string, unknown> = {
        trainingMoment: {
            findFirst: vi.fn(async () => trainingMoment),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        trainingAttempt,
        trainingAttemptStep,
        solutionMoveAssessment,
    };
    rawDb.$transaction = vi.fn(
        async (callback: (tx: unknown) => unknown) =>
            callback(rawDb)
    );
    return {
        db: rawDb as never,
        rawDb,
        getAttempt: () => attempt,
        getAssessment: () => assessment,
        solutionMoveAssessment,
    };
}

function start(moveUci = 'e2e4') {
    return {
        kind: 'START' as const,
        clientAttemptId,
        solutionRevisionId: revisionId,
        moveUci,
    };
}

function bestMetrics(moveUci: string): TrainingMoveMetrics {
    return {
        moveUci,
        originalMoveUci: 'a2a3',
        stable: true,
        bestGapCp: 0,
        bestGapWinChance: 0,
        recoveredCp: 150,
        recoveredWinChance: 0.2,
        preservesOutcome: true,
    };
}

describe('server-authoritative training attempts', () => {
    it('rejects stale START revisions before creating an attempt', async () => {
        const { db, rawDb } = createDb();
        await expect(
            submitTrainingAttempt({
                userId,
                momentId,
                request: {
                    ...start(),
                    solutionRevisionId:
                        '99999999-9999-4999-8999-999999999999',
                },
                dependencies: { db },
            })
        ).rejects.toMatchObject({
            code: 'STALE_REVISION',
            status: 409,
        } satisfies Partial<TrainingAttemptError>);
        const trainingAttemptDelegate = rawDb.trainingAttempt as {
            create: ReturnType<typeof vi.fn>;
        };
        expect(
            trainingAttemptDelegate.create
        ).not.toHaveBeenCalled();
    });

    it('does not trust a cached categorical grade without outcome evidence', async () => {
        const cached: AssessmentState = {
            id: 'assessment-1',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'e2e4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: null,
            evidence: { bestGapCp: 0, bestGapWinChance: 0 },
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db } = createDb({ assessment: cached });
        const evaluateDynamicMove = vi.fn();

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start(),
            dependencies: { db, evaluateDynamicMove },
        });

        expect(response).toEqual({
            attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
        expect(evaluateDynamicMove).not.toHaveBeenCalled();
    });

    it('regrades cached evidence with the pinned policy instead of trusting its grade', async () => {
        const cached: AssessmentState = {
            id: 'assessment-policy-regression',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'd2d4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: -100,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db } = createDb({ assessment: cached });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: { db },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'DIFFERENT_MISTAKE',
            accepted: false,
        });
    });

    it('grades an accepted ENGINE alternative after a RULE-best draw as GOOD instead of unresolved', async () => {
        const repetitionFen =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const afterRule = new Chess(repetitionFen);
        afterRule.move({ from: 'f6', to: 'g8' });
        const afterEngine = new Chess(repetitionFen);
        afterEngine.move({ from: 'e7', to: 'e5' });
        const mixedRevision = {
            ...revision,
            bestMoveUci: 'f6g8',
            acceptedMovesUci: ['f6g8', 'e7e5'],
            scoreAtStart: {
                kind: 'tablebase',
                wdl: 'DRAW',
                pov: 'WHITE',
            },
            solutionTree: {
                fen: repetitionFen,
                ply: 0,
                role: 'USER',
                branches: [
                    {
                        moveUci: 'f6g8',
                        best: true,
                        child: {
                            fen: afterRule.fen(),
                            ply: 1,
                            role: 'TERMINAL',
                            branches: [],
                        },
                    },
                    {
                        moveUci: 'e7e5',
                        best: false,
                        child: {
                            fen: afterEngine.fen(),
                            ply: 1,
                            role: 'TERMINAL',
                            branches: [],
                        },
                    },
                ],
            },
        };
        const mixedMoment = {
            ...moment,
            fen: repetitionFen,
            positionHistory: [],
            sideToMove: 'b',
            originalMoveUci: 'e7e6',
            currentSolutionRevision: mixedRevision,
        };
        const cached: AssessmentState = {
            id: 'assessment-mixed-engine',
            solutionRevisionId: revisionId,
            positionKey: assessmentPositionKey(
                repetitionFen,
                []
            ),
            decisionIndex: 0,
            fen: repetitionFen,
            moveUci: 'e7e5',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'GOOD',
            scoreAfter: {
                kind: 'cp',
                cp: 30,
                pov: 'WHITE',
            },
            evidence: {
                bestGapCp: 30,
                bestGapWinChance: 0.0276,
                preservesOutcome: true,
                evaluation: {
                    source: 'ENGINE',
                    score: { type: 'cp', value: -30 },
                },
            },
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db, getAttempt } = createDb({
            assessment: cached,
            trainingMoment: mixedMoment,
        });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('e7e5'),
            dependencies: { db },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'GOOD',
            accepted: true,
        });
        expect(getAttempt()).toMatchObject({
            bestGapCp: 30,
            gradingEvidence: {
                submittedScoreAfter: {
                    kind: 'cp',
                    cp: 30,
                    pov: 'WHITE',
                },
                preservesOutcome: true,
            },
        });
    });

    it('keeps an in-flight historical attempt pinned to its original solution revision', async () => {
        const attemptId =
            'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const cached: AssessmentState = {
            id: 'assessment-pinned-revision',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'd2d4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'GOOD',
            scoreAfter: {
                kind: 'cp',
                cp: 20,
                pov: 'WHITE',
            },
            evidence: {
                bestGapCp: 30,
                bestGapWinChance: 0.03,
                preservesOutcome: true,
            },
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db, solutionMoveAssessment } = createDb({
            assessment: cached,
            initialAttempt: {
                id: attemptId,
                trainingMomentId: momentId,
                userId,
                solutionRevisionId: revisionId,
                clientAttemptId,
                attemptedAt: new Date(),
                userMoveUci: 'd2d4',
                timeSpentMs: 5,
                status: 'PENDING',
                grade: null,
                gradingSource: null,
                gradingEvidence: {},
                bestGapCp: null,
                bestGapWinChance: null,
                recoveredCp: null,
                recoveredWinChance: null,
                completedAt: null,
                trainingMoment: {
                    ...moment,
                    currentSolutionRevisionId:
                        'revision-new-with-stricter-policy',
                },
                // This is the immutable revision selected when START
                // created the attempt, and remains authoritative.
                solutionRevision: revision,
                steps: [
                    {
                        id: 'step-0',
                        attemptId,
                        stepIndex: 0,
                        actor: 'USER',
                        fenBefore: fen,
                        moveUci: 'd2d4',
                        grade: null,
                        evidence: {},
                        timeSpentMs: 5,
                    },
                ],
            },
        });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: {
                kind: 'STEP',
                clientAttemptId,
                attemptId,
                stepIndex: 0,
                moveUci: 'd2d4',
                timeSpentMs: 5,
            },
            dependencies: { db },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'GOOD',
            accepted: true,
        });
        expect(
            solutionMoveAssessment.findUnique
        ).toHaveBeenCalledWith({
            where: {
                solutionRevisionId_decisionIndex_positionKey_moveUci:
                    expect.objectContaining({
                        solutionRevisionId: revisionId,
                    }),
            },
        });
    });

    it('never lets cached GOOD evidence accept the original mistake', async () => {
        const cachedOriginal: AssessmentState = {
            id: 'assessment-original',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'a2a3',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            // A 30cp source mistake can pass a broad extraction coverage
            // threshold while still falling inside a 50cp practical GOOD
            // tolerance. Replaying it must nevertheless remain repeated.
            grade: 'GOOD',
            scoreAfter: {
                kind: 'cp',
                cp: 20,
                pov: 'WHITE',
            },
            evidence: {
                bestGapCp: 30,
                bestGapWinChance: null,
                preservesOutcome: true,
            },
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db } = createDb({
            assessment: cachedOriginal,
        });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('a2a3'),
            dependencies: { db },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'REPEATED_MISTAKE',
            accepted: false,
        });
    });

    it('returns at most one opponent move without revealing continuation length', async () => {
        const conditionalRevision = {
            ...revision,
            continuationShape: 'CONDITIONAL_LINE',
            solutionTree: {
                fen,
                ply: 0,
                role: 'USER',
                branches: [
                    {
                        moveUci: 'e2e4',
                        best: true,
                        child: {
                            fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                            ply: 1,
                            role: 'OPPONENT',
                            selectedMoveUci: 'e7e5',
                            branches: [
                                {
                                    moveUci: 'e7e5',
                                    best: true,
                                    child: {
                                        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
                                        ply: 2,
                                        role: 'USER',
                                        branches: [],
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const conditionalMoment = {
            ...moment,
            currentSolutionRevision: conditionalRevision,
        };
        const cached: AssessmentState = {
            id: 'assessment-1',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'e2e4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db } = createDb({
            assessment: cached,
            trainingMoment:
                conditionalMoment as unknown as Record<
                    string,
                    unknown
                >,
        });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start(),
            dependencies: { db },
        });

        expect(response).toEqual({
            attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            status: 'AWAITING_CONTINUATION',
            nextStepIndex: 2,
            opponentMove: {
                moveUci: 'e7e5',
                fenAfter:
                    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
            },
        });
        expect(response).not.toHaveProperty('review');
        expect(response).not.toHaveProperty('remainingSteps');
        expect(response).not.toHaveProperty('bestLine');
    });

    it('rejects a losing concurrent STEP payload after P2002', async () => {
        const conditionalRevision = {
            ...revision,
            continuationShape: 'CONDITIONAL_LINE',
            solutionTree: {
                fen,
                ply: 0,
                role: 'USER',
                branches: [
                    {
                        moveUci: 'e2e4',
                        best: true,
                        child: {
                            fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                            ply: 1,
                            role: 'OPPONENT',
                            selectedMoveUci: 'e7e5',
                            branches: [
                                {
                                    moveUci: 'e7e5',
                                    best: true,
                                    child: {
                                        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
                                        ply: 2,
                                        role: 'USER',
                                        branches: [],
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const cached: AssessmentState = {
            id: 'assessment-1',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'e2e4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db, rawDb, solutionMoveAssessment } = createDb({
            assessment: cached,
            trainingMoment: {
                ...moment,
                currentSolutionRevision: conditionalRevision,
            },
        });
        const started = await submitTrainingAttempt({
            userId,
            momentId,
            request: start(),
            dependencies: { db },
        });
        expect(started.status).toBe('AWAITING_CONTINUATION');
        const assessmentReadsBefore =
            solutionMoveAssessment.findUnique.mock.calls.length;
        const transaction = rawDb.$transaction as ReturnType<
            typeof vi.fn
        >;
        transaction.mockRejectedValueOnce({ code: 'P2002' });
        const stepDelegate = rawDb.trainingAttemptStep as {
            findUnique: ReturnType<typeof vi.fn>;
        };
        stepDelegate.findUnique.mockResolvedValueOnce({
            actor: 'USER',
            moveUci: 'b1c3',
            timeSpentMs: 5,
        });

        await expect(
            submitTrainingAttempt({
                userId,
                momentId,
                request: {
                    kind: 'STEP',
                    clientAttemptId,
                    attemptId:
                        'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    stepIndex: 2,
                    moveUci: 'g1f3',
                    timeSpentMs: 10,
                },
                dependencies: { db },
            })
        ).rejects.toMatchObject({
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
        });
        expect(
            solutionMoveAssessment.findUnique
        ).toHaveBeenCalledTimes(assessmentReadsBefore);
        expect(stepDelegate.findUnique).toHaveBeenCalledWith({
            where: {
                attemptId_stepIndex: {
                    attemptId:
                        'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    stepIndex: 2,
                },
            },
            select: {
                actor: true,
                moveUci: true,
                timeSpentMs: true,
            },
        });
    });

    it('returns the authoritative result to concurrent identical START requests', async () => {
        const cached: AssessmentState = {
            id: 'assessment-concurrent-start',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'e2e4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const pendingAttempt = {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            trainingMomentId: momentId,
            userId,
            solutionRevisionId: revisionId,
            clientAttemptId,
            attemptedAt: new Date(),
            userMoveUci: 'e2e4',
            timeSpentMs: null,
            status: 'PENDING',
            grade: null,
            gradingSource: null,
            gradingEvidence: {},
            bestGapCp: null,
            bestGapWinChance: null,
            recoveredCp: null,
            recoveredWinChance: null,
            completedAt: null,
            trainingMoment: moment,
            solutionRevision: revision,
            steps: [
                {
                    id: 'step-0',
                    attemptId:
                        'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    stepIndex: 0,
                    actor: 'USER',
                    fenBefore: fen,
                    moveUci: 'e2e4',
                    grade: null,
                    evidence: {},
                    timeSpentMs: null,
                },
            ],
        };
        const { db } = createDb({
            assessment: cached,
            initialAttempt: pendingAttempt,
        });

        const [first, second] = await Promise.all([
            submitTrainingAttempt({
                userId,
                momentId,
                request: start(),
                dependencies: { db },
            }),
            submitTrainingAttempt({
                userId,
                momentId,
                request: start(),
                dependencies: { db },
            }),
        ]);

        expect(first).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        expect(second).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
    });

    it('returns the authoritative result to concurrent identical STEP requests', async () => {
        const continuationFen =
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
        const continuationAssessmentKey = assessmentPositionKey(
            continuationFen,
            [
                fen,
                'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
            ]
        );
        const conditionalRevision = {
            ...revision,
            continuationShape: 'CONDITIONAL_LINE',
            solutionTree: {
                fen,
                ply: 0,
                role: 'USER',
                branches: [
                    {
                        moveUci: 'e2e4',
                        best: true,
                        child: {
                            fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                            ply: 1,
                            role: 'OPPONENT',
                            selectedMoveUci: 'e7e5',
                            branches: [
                                {
                                    moveUci: 'e7e5',
                                    best: true,
                                    child: {
                                        fen: continuationFen,
                                        ply: 2,
                                        role: 'USER',
                                        branches: [],
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const attemptId =
            'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const cached: AssessmentState = {
            id: 'assessment-concurrent-step',
            solutionRevisionId: revisionId,
            positionKey: continuationAssessmentKey,
            decisionIndex: 1,
            fen: continuationFen,
            moveUci: 'b1c3',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db } = createDb({
            assessment: cached,
            initialAttempt: {
                id: attemptId,
                trainingMomentId: momentId,
                userId,
                solutionRevisionId: revisionId,
                clientAttemptId,
                attemptedAt: new Date(),
                userMoveUci: 'e2e4',
                timeSpentMs: 5,
                status: 'PENDING',
                grade: null,
                gradingSource: 'PRECOMPUTED',
                gradingEvidence: {},
                bestGapCp: 0,
                bestGapWinChance: 0,
                recoveredCp: 150,
                recoveredWinChance: 0.2,
                completedAt: null,
                trainingMoment: {
                    ...moment,
                    currentSolutionRevision:
                        conditionalRevision,
                },
                solutionRevision: conditionalRevision,
                steps: [
                    {
                        id: 'step-0',
                        attemptId,
                        stepIndex: 0,
                        actor: 'USER',
                        fenBefore: fen,
                        moveUci: 'e2e4',
                        grade: 'BEST',
                        evidence: {},
                        timeSpentMs: null,
                    },
                    {
                        id: 'step-1',
                        attemptId,
                        stepIndex: 1,
                        actor: 'ENGINE',
                        fenBefore:
                            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
                        moveUci: 'e7e5',
                        grade: null,
                        evidence: {},
                        timeSpentMs: null,
                    },
                    {
                        id: 'step-2',
                        attemptId,
                        stepIndex: 2,
                        actor: 'USER',
                        fenBefore: continuationFen,
                        moveUci: 'b1c3',
                        grade: null,
                        evidence: {},
                        timeSpentMs: 7,
                    },
                ],
            },
        });
        const request = {
            kind: 'STEP' as const,
            clientAttemptId,
            attemptId,
            stepIndex: 2,
            moveUci: 'b1c3',
            timeSpentMs: 7,
        };

        const responses = await Promise.all([
            submitTrainingAttempt({
                userId,
                momentId,
                request,
                dependencies: { db },
            }),
            submitTrainingAttempt({
                userId,
                momentId,
                request,
                dependencies: { db },
            }),
        ]);

        expect(responses).toEqual([
            expect.objectContaining({
                status: 'GRADED',
                grade: 'BEST',
                review: expect.objectContaining({
                    comparison: null,
                }),
            }),
            expect.objectContaining({
                status: 'GRADED',
                grade: 'BEST',
                review: expect.objectContaining({
                    comparison: null,
                }),
            }),
        ]);
    });

    it('passes ordered source and prior-step history when a later user move completes threefold repetition', async () => {
        const positions = [new Chess().fen()];
        const replay = new Chess();
        for (const moveUci of [
            'g1f3',
            'g8f6',
            'f3g1',
            'f6g8',
            'g1f3',
            'g8f6',
            'f3g1',
        ]) {
            replay.move({
                from: moveUci.slice(0, 2),
                to: moveUci.slice(2, 4),
            });
            positions.push(replay.fen());
        }
        const sourceHistory = positions.slice(0, 5);
        const conditionalRevision = {
            ...revision,
            continuationShape: 'CONDITIONAL_LINE',
            solutionTree: {
                fen: positions[5],
                ply: 0,
                role: 'USER',
                branches: [
                    {
                        moveUci: 'g8f6',
                        best: true,
                        child: {
                            fen: positions[6],
                            ply: 1,
                            role: 'OPPONENT',
                            selectedMoveUci: 'f3g1',
                            branches: [
                                {
                                    moveUci: 'f3g1',
                                    best: true,
                                    child: {
                                        fen: positions[7],
                                        ply: 2,
                                        role: 'USER',
                                        branches: [],
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
        };
        const attemptId =
            'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const laterMoment = {
            ...moment,
            fen: positions[5],
            positionHistory: sourceHistory,
            sideToMove: 'b',
            currentSolutionRevision: conditionalRevision,
        };
        const { db, solutionMoveAssessment } = createDb({
            initialAttempt: {
                id: attemptId,
                trainingMomentId: momentId,
                userId,
                solutionRevisionId: revisionId,
                clientAttemptId,
                attemptedAt: new Date(),
                userMoveUci: 'g8f6',
                timeSpentMs: 5,
                status: 'PENDING',
                grade: null,
                gradingSource: null,
                gradingEvidence: {},
                bestGapCp: null,
                bestGapWinChance: null,
                recoveredCp: null,
                recoveredWinChance: null,
                completedAt: null,
                trainingMoment: laterMoment,
                solutionRevision: conditionalRevision,
                steps: [
                    {
                        id: 'step-0',
                        attemptId,
                        stepIndex: 0,
                        actor: 'USER',
                        fenBefore: positions[5],
                        moveUci: 'g8f6',
                        grade: 'BEST',
                        evidence: {},
                        timeSpentMs: null,
                    },
                    {
                        id: 'step-1',
                        attemptId,
                        stepIndex: 1,
                        actor: 'ENGINE',
                        fenBefore: positions[6],
                        moveUci: 'f3g1',
                        grade: null,
                        evidence: {},
                        timeSpentMs: null,
                    },
                    {
                        id: 'step-2',
                        attemptId,
                        stepIndex: 2,
                        actor: 'USER',
                        fenBefore: positions[7],
                        moveUci: 'f6g8',
                        grade: null,
                        evidence: {},
                        timeSpentMs: 10,
                    },
                ],
            },
        });
        const expectedHistory = [
            ...sourceHistory,
            positions[5]!,
            positions[6]!,
        ];
        const evaluator = vi.fn(async (args: {
            moveUci: string;
            positionHistory: string[];
        }) => {
            expect(args.positionHistory).toEqual(expectedHistory);
            return {
                source: 'DYNAMIC' as const,
                scoreAfter: {
                    kind: 'tablebase' as const,
                    wdl: 'DRAW' as const,
                    pov: 'WHITE' as const,
                },
                metrics: bestMetrics(args.moveUci),
                evidence: {
                    source: 'RULE',
                    terminal: 'THREEFOLD_REPETITION',
                },
            };
        });

        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: {
                kind: 'STEP',
                clientAttemptId,
                attemptId,
                stepIndex: 2,
                moveUci: 'f6g8',
                timeSpentMs: 10,
            },
            dependencies: {
                db,
                evaluateDynamicMove: evaluator,
            },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        expect(evaluator).toHaveBeenCalledTimes(1);
        expect(
            solutionMoveAssessment.create.mock.calls[0]?.[0].data
                .positionKey
        ).toBe(
            assessmentPositionKey(positions[7]!, expectedHistory)
        );
        expect(
            assessmentPositionKey(positions[7]!, expectedHistory)
        ).not.toBe(
            assessmentPositionKey(positions[7]!, sourceHistory)
        );
    });

    it('returns UNRESOLVED without review when dynamic evidence fails', async () => {
        const { db } = createDb();
        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: {
                db,
                evaluateDynamicMove: vi
                    .fn()
                    .mockRejectedValue(new Error('engine timeout')),
            },
        });

        expect(response).toEqual({
            attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            status: 'UNRESOLVED',
            reason: 'ENGINE_UNAVAILABLE',
        });
        expect(response).not.toHaveProperty('review');
    });

    it('retries an unresolved step with a fenced retry operation and can grade it', async () => {
        const { db } = createDb();
        const evaluator = vi
            .fn()
            .mockRejectedValueOnce(new Error('engine timeout'))
            .mockImplementationOnce(async ({ moveUci }) => ({
                source: 'DYNAMIC' as const,
                scoreAfter: {
                    kind: 'cp' as const,
                    cp: 50,
                    pov: 'WHITE' as const,
                },
                metrics: bestMetrics(moveUci),
                evidence: { stableRetry: true },
            }));
        const unresolved = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: { db, evaluateDynamicMove: evaluator },
        });
        expect(unresolved).toMatchObject({
            status: 'UNRESOLVED',
            reason: 'ENGINE_UNAVAILABLE',
        });

        const retryRequest = {
            kind: 'RETRY' as const,
            clientAttemptId,
            attemptId: unresolved.attemptId,
            stepIndex: 0,
            retryId:
                '55555555-5555-4555-8555-555555555555',
        };
        const retried = await submitTrainingAttempt({
            userId,
            momentId,
            request: retryRequest,
            dependencies: { db, evaluateDynamicMove: evaluator },
        });

        expect(evaluator).toHaveBeenCalledTimes(2);
        expect(retried).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
        await expect(
            submitTrainingAttempt({
                userId,
                momentId,
                request: retryRequest,
                dependencies: {
                    db,
                    evaluateDynamicMove: evaluator,
                },
            })
        ).resolves.toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        expect(evaluator).toHaveBeenCalledTimes(2);
    });

    it('leases unknown-move assessment once and reports concurrent retry as busy', async () => {
        const { db } = createDb();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const evaluator = vi.fn(async ({ moveUci }) => {
            await gate;
            return {
                source: 'DYNAMIC' as const,
                scoreAfter: {
                    kind: 'cp' as const,
                    cp: 50,
                    pov: 'WHITE' as const,
                },
                metrics: bestMetrics(moveUci),
                evidence: { stable: true },
            };
        });
        const first = submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: { db, evaluateDynamicMove: evaluator },
        });
        await vi.waitFor(() => expect(evaluator).toHaveBeenCalledTimes(1));

        await expect(
            submitTrainingAttempt({
                userId,
                momentId,
                request: start('d2d4'),
                dependencies: { db, evaluateDynamicMove: evaluator },
            })
        ).rejects.toMatchObject({
            code: 'GRADING_BUSY',
            status: 429,
        });
        release();
        await expect(first).resolves.toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        expect(evaluator).toHaveBeenCalledTimes(1);
    });

    it('recovers a stale PENDING assessment lease', async () => {
        const stale: AssessmentState = {
            id: 'assessment-1',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'd2d4',
            source: 'DYNAMIC',
            status: 'PENDING',
            grade: null,
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 1,
            lockedAt: new Date('2025-12-31T23:58:00.000Z'),
            lockedUntil: new Date('2025-12-31T23:59:00.000Z'),
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db, getAssessment } = createDb({ assessment: stale });
        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: {
                db,
                now: () =>
                    new Date('2026-01-01T00:00:00.000Z'),
                evaluateDynamicMove: vi.fn(async ({ moveUci }) => ({
                    source: 'DYNAMIC' as const,
                    scoreAfter: {
                        kind: 'cp' as const,
                        cp: 50,
                        pov: 'WHITE' as const,
                    },
                    metrics: bestMetrics(moveUci),
                    evidence: { recovered: true },
                })),
            },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        expect(getAssessment()).toMatchObject({
            status: 'VERIFIED',
            attempts: 2,
            lockedAt: null,
            lockedUntil: null,
        });
    });

    it('expires a stale PENDING attempt before claiming the user slot', async () => {
        const cached: AssessmentState = {
            id: 'assessment-1',
            solutionRevisionId: revisionId,
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen,
            moveUci: 'e2e4',
            source: 'PRECOMPUTED',
            status: 'VERIFIED',
            grade: 'BEST',
            scoreAfter: {
                kind: 'cp',
                cp: 50,
                pov: 'WHITE',
            },
            evidence: {},
            attempts: 0,
            lockedAt: null,
            lockedUntil: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const { db, rawDb } = createDb({
            assessment: cached,
            initialAttempt: {
                id: 'stale-attempt',
                userId,
                clientAttemptId:
                    '11111111-1111-4111-8111-111111111111',
                status: 'PENDING',
                attemptedAt: new Date(
                    '2025-12-31T23:00:00.000Z'
                ),
            },
        });
        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: {
                ...start(),
                clientAttemptId:
                    '22222222-2222-4222-8222-222222222222',
            },
            dependencies: {
                db,
                now: () =>
                    new Date('2026-01-01T00:00:00.000Z'),
            },
        });

        expect(response).toMatchObject({
            status: 'GRADED',
            grade: 'BEST',
        });
        const trainingAttemptDelegate = rawDb.trainingAttempt as {
            updateMany: ReturnType<typeof vi.fn>;
        };
        expect(
            trainingAttemptDelegate.updateMany
        ).toHaveBeenCalledWith({
            where: {
                userId,
                status: 'PENDING',
                attemptedAt: {
                    lte: new Date(
                        '2025-12-31T23:30:00.000Z'
                    ),
                },
            },
            data: {
                status: 'UNRESOLVED',
                gradingEvidence: {
                    reason: 'ENGINE_UNAVAILABLE',
                    recovery: 'STALE_PENDING_ATTEMPT',
                },
                completedAt: new Date(
                    '2026-01-01T00:00:00.000Z'
                ),
            },
        });
    });

    it('does not cache unstable dynamic evidence as VERIFIED', async () => {
        const { db, getAssessment } = createDb();
        const response = await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: {
                db,
                evaluateDynamicMove: vi.fn(async ({ moveUci }) => ({
                    source: 'DYNAMIC' as const,
                    scoreAfter: null,
                    metrics: {
                        ...bestMetrics(moveUci),
                        stable: false,
                    },
                    evidence: { depthVariance: 200 },
                })),
            },
        });

        expect(response).toEqual({
            attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
        expect(getAssessment()).toMatchObject({
            status: 'FAILED',
            lastError: 'UNSTABLE_EVIDENCE',
        });
    });

    it('rejects reuse of a clientAttemptId with a different payload', async () => {
        const { db } = createDb();
        await submitTrainingAttempt({
            userId,
            momentId,
            request: start('d2d4'),
            dependencies: {
                db,
                evaluateDynamicMove: vi.fn(async ({ moveUci }) => ({
                    source: 'DYNAMIC' as const,
                    scoreAfter: {
                        kind: 'cp' as const,
                        cp: 50,
                        pov: 'WHITE' as const,
                    },
                    metrics: bestMetrics(moveUci),
                    evidence: {},
                })),
            },
        });

        await expect(
            submitTrainingAttempt({
                userId,
                momentId,
                request: start('g1f3'),
                dependencies: { db },
            })
        ).rejects.toMatchObject({
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
        });
    });

    it('reveals post-attempt review idempotently', async () => {
        const { db, rawDb } = createDb();
        const request = {
            clientAttemptId,
            solutionRevisionId: revisionId,
        };

        const first = await revealTrainingMoment({
            userId,
            momentId,
            request,
            dependencies: { db },
        });
        const second = await revealTrainingMoment({
            userId,
            momentId,
            request,
            dependencies: { db },
        });

        expect(first).toMatchObject({
            status: 'REVEALED',
            review: {
                trainingSide: 'w',
                originalMoveUci: 'a2a3',
                submittedMoveUci: null,
                bestMoveUci: 'e2e4',
                acceptedMovesComplete: true,
            },
        });
        expect(second).toEqual(first);
        const trainingAttemptDelegate = rawDb.trainingAttempt as {
            create: ReturnType<typeof vi.fn>;
        };
        expect(trainingAttemptDelegate.create).toHaveBeenCalledTimes(
            1
        );
    });
});
