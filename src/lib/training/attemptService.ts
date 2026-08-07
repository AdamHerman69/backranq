import { Chess } from 'chess.js';
import { Prisma, type PrismaClient } from '@prisma/client';

import type {
    RecordTrainingAttemptRequest,
    RecordTrainingAttemptResponse,
    TrainingApiErrorCode,
} from '@/lib/training/api';
import type { AttemptGrade } from '@/lib/training/contracts';
import { aggregateTrainingGrade } from '@/lib/training/localGrading';

type TrainingWriteDb = Pick<
    PrismaClient,
    '$transaction' | 'trainingMoment' | 'trainingAttempt'
>;

const attemptMomentSelect = {
    id: true,
    fen: true,
    phase: true,
    cpLoss: true,
    winChanceLoss: true,
    sourceKinds: true,
    lessonKinds: true,
    themes: true,
    currentSolutionRevisionId: true,
    game: {
        select: {
            provider: true,
            timeClass: true,
        },
    },
    currentSolutionRevision: {
        select: {
            trainable: true,
            verificationStatus: true,
            acceptanceFrontier: true,
            solutionHash: true,
            configHash: true,
        },
    },
} satisfies Prisma.TrainingMomentSelect;

type AttemptMoment = Prisma.TrainingMomentGetPayload<{
    select: typeof attemptMomentSelect;
}>;

const PRACTICE_THEME_TAXONOMY_VERSION = 'backranq-theme-v1';
const PRACTICE_REVIEW_ALGORITHM_VERSION = 'backranq-review-v1';

function attemptContext(
    moment: AttemptMoment,
    revision: NonNullable<AttemptMoment['currentSolutionRevision']>
) {
    return {
        contextPhase: moment.phase,
        contextCpLoss: moment.cpLoss,
        contextWinChanceLoss: moment.winChanceLoss,
        contextSourceKinds: moment.sourceKinds,
        contextLessonKinds: moment.lessonKinds,
        contextThemes: moment.themes,
        contextThemeTaxonomyVersion:
            PRACTICE_THEME_TAXONOMY_VERSION,
        contextProvider: moment.game.provider,
        contextTimeClass: moment.game.timeClass,
        contextConfigHash: revision.configHash,
        contextSolutionHash: revision.solutionHash,
    };
}

type PracticeEvidenceTx = Pick<
    Prisma.TransactionClient,
    | 'trainingAttemptStatusEvent'
    | 'practiceReviewState'
    | 'practiceReviewEvent'
>;

async function appendAttemptStatusEvent(args: {
    tx: PracticeEvidenceTx;
    attemptId: string;
    userId: string;
    status: 'GRADED' | 'REVEALED';
    grade?: AttemptGrade | null;
    occurredAt: Date;
}) {
    await args.tx.trainingAttemptStatusEvent.create({
        data: {
            attemptId: args.attemptId,
            userId: args.userId,
            eventKey:
                args.status === 'GRADED'
                    ? 'graded'
                    : 'revealed',
            status: args.status,
            grade: args.grade ?? null,
            reason:
                args.status === 'GRADED'
                    ? 'GRADED'
                    : 'REVEALED',
            occurredAt: args.occurredAt,
        },
    });
}

async function recordReviewEvidence(args: {
    tx: PracticeEvidenceTx;
    attemptId: string;
    userId: string;
    trainingMomentId: string;
    solutionHash: string;
    configHash: string;
    grade?: AttemptGrade;
    revealed: boolean;
    occurredAt: Date;
}) {
    const eventKey = `${args.attemptId}:review`;
    const recorded = await args.tx.practiceReviewEvent.findUnique({
        where: {
            userId_eventKey: {
                userId: args.userId,
                eventKey,
            },
        },
        select: { id: true },
    });
    if (recorded) return;

    const existing = await args.tx.practiceReviewState.findUnique({
        where: {
            userId_trainingMomentId_solutionHash_configHash: {
                userId: args.userId,
                trainingMomentId: args.trainingMomentId,
                solutionHash: args.solutionHash,
                configHash: args.configHash,
            },
        },
        select: {
            id: true,
            intervalDays: true,
            lapses: true,
            successes: true,
        },
    });
    const success =
        !args.revealed &&
        (args.grade === 'BEST' ||
            args.grade === 'STRONG' ||
            args.grade === 'GOOD');
    const intervalBeforeDays = existing?.intervalDays ?? 0;
    const intervalAfterDays = success
        ? existing?.successes
            ? Math.min(
                  60,
                  existing.successes === 1
                      ? 3
                      : Math.max(3, intervalBeforeDays * 2)
              )
            : 1
        : 1;
    const nextDueAt = new Date(
        args.occurredAt.getTime() +
            intervalAfterDays * 24 * 60 * 60 * 1_000
    );
    const state = await args.tx.practiceReviewState.upsert({
        where: {
            userId_trainingMomentId_solutionHash_configHash: {
                userId: args.userId,
                trainingMomentId: args.trainingMomentId,
                solutionHash: args.solutionHash,
                configHash: args.configHash,
            },
        },
        create: {
            userId: args.userId,
            trainingMomentId: args.trainingMomentId,
            solutionHash: args.solutionHash,
            configHash: args.configHash,
            nextDueAt,
            intervalDays: intervalAfterDays,
            lapses: success ? 0 : 1,
            successes: success ? 1 : 0,
            algorithmVersion:
                PRACTICE_REVIEW_ALGORITHM_VERSION,
            lastReviewedAt: args.occurredAt,
        },
        update: {
            nextDueAt,
            intervalDays: intervalAfterDays,
            lapses: success
                ? existing?.lapses ?? 0
                : (existing?.lapses ?? 0) + 1,
            successes: success
                ? (existing?.successes ?? 0) + 1
                : existing?.successes ?? 0,
            algorithmVersion:
                PRACTICE_REVIEW_ALGORITHM_VERSION,
            lastReviewedAt: args.occurredAt,
        },
        select: { id: true },
    });
    await args.tx.practiceReviewEvent.create({
        data: {
            stateId: state.id,
            attemptId: args.attemptId,
            userId: args.userId,
            eventKey,
            outcome: args.revealed
                ? 'REVEAL'
                : success
                  ? 'SUCCESS'
                  : 'LAPSE',
            grade: args.grade ?? null,
            occurredAt: args.occurredAt,
            intervalBeforeDays,
            intervalAfterDays,
            nextDueAt,
            algorithmVersion:
                PRACTICE_REVIEW_ALGORITHM_VERSION,
        },
    });
}

export type TrainingAttemptDependencies = {
    db: TrainingWriteDb;
    now?: () => Date;
};

export class TrainingAttemptError extends Error {
    constructor(
        message: string,
        readonly code: TrainingApiErrorCode,
        readonly status: number
    ) {
        super(message);
        this.name = 'TrainingAttemptError';
    }
}

function normalizeUci(move: string): string {
    return move.trim().toLowerCase();
}

function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
    return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002'
    );
}

function applyUci(fen: string, moveUci: string): string | null {
    const move = normalizeUci(moveUci);
    try {
        const chess = new Chess(fen);
        const played = chess.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.slice(4, 5) || undefined,
        });
        return played ? chess.fen() : null;
    } catch {
        return null;
    }
}

function assertValidRecordedLine(
    rootFen: string,
    request: RecordTrainingAttemptRequest
) {
    if (request.status === 'GRADED' && request.steps.length === 0) {
        throw new TrainingAttemptError(
            'A graded attempt requires at least one move',
            'INVALID_REQUEST',
            400
        );
    }
    let fen = rootFen;
    const userGrades: AttemptGrade[] = [];
    for (let index = 0; index < request.steps.length; index += 1) {
        const step = request.steps[index]!;
        const expectedActor = index % 2 === 0 ? 'USER' : 'ENGINE';
        if (
            step.stepIndex !== index ||
            step.actor !== expectedActor ||
            step.fenBefore !== fen
        ) {
            throw new TrainingAttemptError(
                'Recorded attempt line is inconsistent',
                'INVALID_REQUEST',
                400
            );
        }
        const nextFen = applyUci(fen, step.moveUci);
        if (!nextFen) {
            throw new TrainingAttemptError(
                'Recorded attempt contains an illegal move',
                'ILLEGAL_MOVE',
                400
            );
        }
        if (step.actor === 'USER') {
            if (!step.grade) {
                throw new TrainingAttemptError(
                    'Every recorded user decision needs a grade',
                    'INVALID_REQUEST',
                    400
                );
            }
            userGrades.push(step.grade);
        } else if (step.grade || step.source || step.comparison) {
            throw new TrainingAttemptError(
                'Engine continuation steps cannot carry a grade',
                'INVALID_REQUEST',
                400
            );
        }
        fen = nextFen;
    }
    if (request.status === 'GRADED') {
        if (
            !request.grade ||
            request.steps.at(-1)?.actor !== 'USER' ||
            aggregateTrainingGrade(userGrades) !== request.grade
        ) {
            throw new TrainingAttemptError(
                'Recorded aggregate grade is inconsistent',
                'INVALID_REQUEST',
                400
            );
        }
    } else if (request.grade || request.gradingSource) {
        throw new TrainingAttemptError(
            'A revealed attempt cannot carry a grade',
            'INVALID_REQUEST',
            400
        );
    }
}

function assertIdempotentRecord(
    existing: {
        trainingMomentId: string;
        solutionRevisionId: string;
    },
    args: {
        momentId: string;
        request: RecordTrainingAttemptRequest;
    }
) {
    if (
        existing.trainingMomentId !== args.momentId ||
        existing.solutionRevisionId !==
            args.request.solutionRevisionId
    ) {
        throw new TrainingAttemptError(
            'clientAttemptId payload conflict',
            'IDEMPOTENCY_CONFLICT',
            409
        );
    }
}

export async function recordTrainingAttempt(args: {
    userId: string;
    momentId: string;
    request: RecordTrainingAttemptRequest;
    dependencies: TrainingAttemptDependencies;
}): Promise<RecordTrainingAttemptResponse> {
    const db = args.dependencies.db;
    const now = args.dependencies.now?.() ?? new Date();
    const existing = await db.trainingAttempt.findUnique({
        where: {
            userId_clientAttemptId: {
                userId: args.userId,
                clientAttemptId: args.request.clientAttemptId,
            },
        },
        select: {
            id: true,
            trainingMomentId: true,
            solutionRevisionId: true,
        },
    });
    if (existing) {
        assertIdempotentRecord(existing, args);
        return { attemptId: existing.id, status: 'RECORDED' };
    }

    const moment = await db.trainingMoment.findFirst({
        where: {
            id: args.momentId,
            userId: args.userId,
            status: 'ACTIVE',
            archivedAt: null,
        },
        select: attemptMomentSelect,
    });
    if (!moment?.currentSolutionRevision) {
        throw new TrainingAttemptError(
            'Training moment not found',
            'NOT_FOUND',
            404
        );
    }
    const revision = moment.currentSolutionRevision;
    if (
        moment.currentSolutionRevisionId !==
        args.request.solutionRevisionId
    ) {
        throw new TrainingAttemptError(
            'Training solution changed; reload the position',
            'STALE_REVISION',
            409
        );
    }
    if (
        !revision.trainable ||
        revision.verificationStatus !== 'VERIFIED' ||
        !hasStableAcceptanceFrontier(revision.acceptanceFrontier)
    ) {
        throw new TrainingAttemptError(
            'Training moment is not currently trainable',
            'NOT_FOUND',
            404
        );
    }

    assertValidRecordedLine(moment.fen, args.request);
    const userSteps = args.request.steps.filter(
        (step) => step.actor === 'USER'
    );
    const firstUserStep = userSteps[0] ?? null;
    const comparison = args.request.comparison ?? null;

    try {
        const attempt = await db.$transaction(async (tx) => {
            const created = await tx.trainingAttempt.create({
                data: {
                    trainingMomentId: args.momentId,
                    userId: args.userId,
                    solutionRevisionId:
                        args.request.solutionRevisionId,
                    clientAttemptId:
                        args.request.clientAttemptId,
                    userMoveUci: firstUserStep?.moveUci ?? null,
                    timeSpentMs:
                        firstUserStep?.timeSpentMs ?? null,
                    status: args.request.status,
                    grade:
                        args.request.status === 'GRADED'
                            ? args.request.grade
                            : null,
                    gradingSource:
                        args.request.status === 'GRADED'
                            ? args.request.gradingSource ?? null
                            : null,
                    gradingEvidence: json({
                        clientGraded: true,
                        submittedScoreAfter:
                            comparison?.submittedScoreAfter ?? null,
                        preservesOutcome:
                            comparison?.preservesOutcome ?? null,
                    }),
                    bestGapCp:
                        comparison?.bestGapCp == null
                            ? null
                            : Math.round(comparison.bestGapCp),
                    bestGapWinChance:
                        comparison?.bestGapWinChance ?? null,
                    recoveredCp:
                        comparison?.recoveredCp == null
                            ? null
                            : Math.round(comparison.recoveredCp),
                    recoveredWinChance:
                        comparison?.recoveredWinChance ?? null,
                    completedAt: now,
                    ...attemptContext(
                        moment,
                        revision
                    ),
                },
                select: { id: true },
            });
            if (args.request.steps.length > 0) {
                await tx.trainingAttemptStep.createMany({
                    data: args.request.steps.map((step) => ({
                        attemptId: created.id,
                        stepIndex: step.stepIndex,
                        actor: step.actor,
                        fenBefore: step.fenBefore,
                        moveUci: normalizeUci(step.moveUci),
                        grade: step.grade ?? null,
                        evidence: json({
                            clientGraded:
                                step.actor === 'USER',
                            source: step.source ?? null,
                            comparison:
                                step.comparison ?? null,
                        }),
                        timeSpentMs: step.timeSpentMs ?? null,
                    })),
                });
            }
            await tx.trainingMoment.updateMany({
                where: {
                    id: args.momentId,
                    userId: args.userId,
                    status: 'ACTIVE',
                },
                data: { lastTrainedAt: now },
            });
            await appendAttemptStatusEvent({
                tx,
                attemptId: created.id,
                userId: args.userId,
                status: args.request.status,
                grade:
                    args.request.status === 'GRADED'
                        ? args.request.grade
                        : null,
                occurredAt: now,
            });
            await recordReviewEvidence({
                tx,
                attemptId: created.id,
                userId: args.userId,
                trainingMomentId: moment.id,
                solutionHash:
                    revision.solutionHash,
                configHash:
                    revision.configHash,
                grade:
                    args.request.status === 'GRADED'
                        ? args.request.grade
                        : undefined,
                revealed: args.request.status === 'REVEALED',
                occurredAt: now,
            });
            return created;
        });
        return { attemptId: attempt.id, status: 'RECORDED' };
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await db.trainingAttempt.findUnique({
            where: {
                userId_clientAttemptId: {
                    userId: args.userId,
                    clientAttemptId:
                        args.request.clientAttemptId,
                },
            },
            select: {
                id: true,
                trainingMomentId: true,
                solutionRevisionId: true,
            },
        });
        if (!winner) throw error;
        assertIdempotentRecord(winner, args);
        return { attemptId: winner.id, status: 'RECORDED' };
    }
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
