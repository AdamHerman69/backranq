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
        trainingAttempt: {
            create: vi.fn().mockResolvedValue(created),
        },
        trainingAttemptStep: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        trainingMoment: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
                currentSolutionRevisionId: revisionId,
                currentSolutionRevision: {
                    trainable: true,
                    verificationStatus: 'VERIFIED',
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
        expect(tx.trainingAttempt.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                status: 'GRADED',
                grade: 'BEST',
                gradingSource: 'PRECOMPUTED',
                userMoveUci: 'e2e4',
                gradingEvidence: expect.objectContaining({
                    clientGraded: true,
                }),
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
    });
});
