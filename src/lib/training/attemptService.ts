import { createHash } from 'node:crypto';

import { Chess } from 'chess.js';
import { Prisma, type PrismaClient } from '@prisma/client';

import type {
    RecordTrainingAttemptRequest,
    RecordTrainingAttemptResponse,
    RecordedTrainingAttemptStepDto,
    TrainingApiErrorCode,
    TrainingComparisonDto,
    TrainingGradingManifestDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import type { AttemptGrade } from '@/lib/training/contracts';
import { toTrainingPromptDto } from '@/lib/training/apiMappers';
import {
    aggregateTrainingGrade,
    gradeKnownLocalMove,
} from '@/lib/training/localGrading';

type TrainingWriteDb = Pick<
    PrismaClient,
    '$transaction' | 'trainingMoment' | 'trainingAttempt'
>;

const attemptMomentSelect = {
    id: true,
    fen: true,
    sideToMove: true,
    positionHistory: true,
    originalMoveUci: true,
    scoreBefore: true,
    scoreAfter: true,
    gameId: true,
    decisionPly: true,
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
            playedAt: true,
        },
    },
    currentSolutionRevision: {
        select: {
            trainable: true,
            verificationStatus: true,
            acceptanceFrontier: true,
            solutionHash: true,
            configHash: true,
            bestMoveUci: true,
            acceptedMovesUci: true,
            solutionShape: true,
            bestLine: true,
            scoreAtStart: true,
            gradingPolicy: true,
            solutionTree: true,
            moveAssessments: {
                select: {
                    decisionIndex: true,
                    fen: true,
                    moveUci: true,
                    source: true,
                    status: true,
                    grade: true,
                    scoreAfter: true,
                    evidence: true,
                },
            },
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
    | '$queryRaw'
    | 'trainingAttemptStatusEvent'
    | 'practiceReviewState'
    | 'practiceReviewEvent'
>;

async function lockPracticeReviewStream(args: {
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>;
    userId: string;
    trainingMomentId: string;
    expectedSolutionRevisionId: string;
}) {
    const lockKey = [
        'practice-review',
        args.userId,
        args.trainingMomentId,
    ].join(':');

    // Review state is maintained as an absolute scheduler snapshot. Serialize
    // every distinct attempt for one owner + Position before any read/derive/
    // write step so concurrent transactions cannot overwrite an increment.
    const rows = await args.tx.$queryRaw<
        Array<{
            acquired: boolean;
            currentSolutionRevisionId: string;
        }>
    >`
        WITH "practice_review_lock" AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(
                hashtextextended(${lockKey}, 0)
            )
        )
        SELECT
            TRUE AS "acquired",
            moment."currentSolutionRevisionId"
        FROM "practice_review_lock"
        CROSS JOIN LATERAL (
            SELECT "currentSolutionRevisionId"
            FROM "TrainingMoment"
            WHERE "id" = ${args.trainingMomentId}::uuid
              AND "userId" = ${args.userId}::uuid
              AND "status" = 'ACTIVE'
              AND "archivedAt" IS NULL
            FOR UPDATE
        ) AS moment
    `;
    if (
        rows[0]?.currentSolutionRevisionId !==
        args.expectedSolutionRevisionId
    ) {
        throw new TrainingAttemptError(
            'Training solution changed; reload the position',
            'STALE_REVISION',
            409
        );
    }
}

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
            nextDueAt: true,
            lastReviewedAt: true,
            algorithmVersion: true,
        },
    });
    const success =
        !args.revealed &&
        (args.grade === 'BEST' ||
            args.grade === 'STRONG' ||
            args.grade === 'GOOD');
    const intervalBeforeDays = existing?.intervalDays ?? 0;
    const scheduledIntervalDays = success
        ? existing?.successes
            ? Math.min(
                  60,
                  existing.successes === 1
                      ? 3
                      : Math.max(3, intervalBeforeDays * 2)
              )
            : 1
        : 1;
    const advancesSchedule =
        !existing ||
        args.occurredAt.getTime() >
            existing.lastReviewedAt.getTime();
    // A delayed offline attempt remains durable evidence and increments the
    // counters, but it must not move a newer schedule backwards.
    const intervalAfterDays = advancesSchedule
        ? scheduledIntervalDays
        : existing.intervalDays;
    const lastReviewedAt = advancesSchedule
        ? args.occurredAt
        : existing.lastReviewedAt;
    const nextDueAt = advancesSchedule
        ? new Date(
              args.occurredAt.getTime() +
                  intervalAfterDays * 24 * 60 * 60 * 1_000
          )
        : existing.nextDueAt;
    const algorithmVersion = advancesSchedule
        ? PRACTICE_REVIEW_ALGORITHM_VERSION
        : existing.algorithmVersion;
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
            algorithmVersion,
            lastReviewedAt,
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
            algorithmVersion,
            lastReviewedAt,
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

type CanonicalRecordedStep = {
    request: RecordedTrainingAttemptStepDto;
    grade: AttemptGrade | null;
    source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE' | null;
    comparison: TrainingComparisonDto | null;
    evidence: unknown;
};

type CanonicalAttempt = {
    grade: AttemptGrade | null;
    gradingSource: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE' | null;
    comparison: TrainingComparisonDto | null;
    steps: CanonicalRecordedStep[];
};

function invalidAttempt(message: string): never {
    throw new TrainingAttemptError(message, 'INVALID_REQUEST', 400);
}

function canonicalSelectedBranch(node: TrainingSolutionTreeNodeDto) {
    return (
        node.branches.find(
            (branch) =>
                normalizeUci(branch.moveUci) ===
                normalizeUci(node.selectedMoveUci ?? '')
        ) ??
        node.branches.find((branch) => branch.best) ??
        node.branches[0] ??
        null
    );
}

function aggregateCanonicalGradingSource(
    steps: readonly CanonicalRecordedStep[]
): 'PRECOMPUTED' | 'TABLEBASE' | null {
    const userSources = steps.flatMap((step) =>
        step.request.actor === 'USER' && step.source ? [step.source] : []
    );
    return userSources.includes('TABLEBASE')
        ? 'TABLEBASE'
        : userSources.includes('PRECOMPUTED')
          ? 'PRECOMPUTED'
          : null;
}

function canonicalizeRecordedLine(
    rootFen: string,
    request: RecordTrainingAttemptRequest,
    manifest: TrainingGradingManifestDto
): CanonicalAttempt {
    const revealed = request.status === 'REVEALED';
    if (revealed) {
        if (
            request.grade ||
            request.gradingSource ||
            request.comparison
        ) {
            invalidAttempt(
                'A revealed attempt cannot carry aggregate grading evidence'
            );
        }
        if (request.steps.length === 0) {
            return {
                grade: null,
                gradingSource: null,
                comparison: null,
                steps: [],
            };
        }
    }
    if (request.steps.length === 0) {
        throw new TrainingAttemptError(
            'A graded attempt requires at least one move',
            'INVALID_REQUEST',
            400
        );
    }
    let fen = rootFen;
    let node: TrainingSolutionTreeNodeDto | null = manifest.solutionTree;
    const userGrades: AttemptGrade[] = [];
    const canonicalSteps: CanonicalRecordedStep[] = [];
    for (let index = 0; index < request.steps.length; index += 1) {
        const step = request.steps[index]!;
        const expectedActor = index % 2 === 0 ? 'USER' : 'ENGINE';
        const expectedNodeRole =
            expectedActor === 'USER' ? 'USER' : 'OPPONENT';
        if (
            step.stepIndex !== index ||
            step.actor !== expectedActor ||
            step.fenBefore !== fen ||
            !node ||
            node.fen !== fen ||
            node.role !== expectedNodeRole
        ) {
            invalidAttempt('Recorded attempt line is inconsistent');
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
            const evaluation = gradeKnownLocalMove({
                manifest,
                node,
                moveUci: step.moveUci,
            });
            if (!evaluation || evaluation.result.status !== 'GRADED') {
                invalidAttempt('Recorded move has no verified grading evidence');
            }
            if (
                evaluation.source === 'DYNAMIC' ||
                step.grade !== evaluation.result.grade ||
                step.source === 'DYNAMIC' ||
                (step.source !== undefined &&
                    step.source !== evaluation.source)
            ) {
                invalidAttempt('Recorded move grade does not match the verified solution');
            }
            userGrades.push(evaluation.result.grade);
            canonicalSteps.push({
                request: step,
                grade: evaluation.result.grade,
                source: evaluation.source,
                comparison: evaluation.comparison,
                evidence: evaluation.evidence,
            });
            const branch:
                | TrainingSolutionTreeNodeDto['branches'][number]
                | undefined = node.branches.find(
                (candidate) =>
                    normalizeUci(candidate.moveUci) ===
                    normalizeUci(step.moveUci)
            );
            node = branch?.child ?? null;
            if (!node && index !== request.steps.length - 1) {
                invalidAttempt('A rejected move cannot have a continuation');
            }
        } else if (step.grade || step.source || step.comparison) {
            invalidAttempt('Engine continuation steps cannot carry a grade');
        } else {
            const branch = canonicalSelectedBranch(node);
            if (
                !branch ||
                normalizeUci(branch.moveUci) !== normalizeUci(step.moveUci)
            ) {
                invalidAttempt('Recorded engine continuation is not canonical');
            }
            canonicalSteps.push({
                request: step,
                grade: null,
                source: null,
                comparison: null,
                evidence: { serverVerified: true, kind: 'CANONICAL_CONTINUATION' },
            });
            node = branch.child;
        }
        fen = nextFen;
    }
    if (revealed) {
        return {
            grade: null,
            gradingSource: null,
            comparison: null,
            steps: canonicalSteps,
        };
    }
    const grade = aggregateTrainingGrade(userGrades);
    const firstUserStep = canonicalSteps.find(
        (step) => step.request.actor === 'USER'
    );
    const canonicalGradingSource =
        aggregateCanonicalGradingSource(canonicalSteps);
    if (
        request.steps.at(-1)?.actor !== 'USER' ||
        (node !== null && node.role !== 'TERMINAL') ||
        request.grade !== grade ||
        request.gradingSource === 'DYNAMIC' ||
        (request.gradingSource !== undefined &&
            request.gradingSource !== canonicalGradingSource)
    ) {
        invalidAttempt('Recorded aggregate grade is inconsistent');
    }
    return {
        grade,
        gradingSource: canonicalGradingSource,
        comparison: firstUserStep?.comparison ?? null,
        steps: canonicalSteps,
    };
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

export function trainingAttemptPayloadHash(args: {
    momentId: string;
    request: RecordTrainingAttemptRequest;
}): string {
    return createHash('sha256')
        .update(
            stableJson({
                version: 1,
                momentId: args.momentId,
                request: args.request,
            })
        )
        .digest('hex');
}

function assertIdempotentRecord(
    existing: {
        trainingMomentId: string;
        solutionRevisionId: string;
        clientPayloadHash: string;
    },
    args: {
        momentId: string;
        request: RecordTrainingAttemptRequest;
        clientPayloadHash: string;
    }
) {
    if (
        existing.trainingMomentId !== args.momentId ||
        existing.solutionRevisionId !== args.request.solutionRevisionId ||
        existing.clientPayloadHash !== args.clientPayloadHash
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
    const clientPayloadHash = trainingAttemptPayloadHash(args);
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
            clientPayloadHash: true,
        },
    });
    if (existing) {
        assertIdempotentRecord(existing, { ...args, clientPayloadHash });
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

    let manifest: TrainingGradingManifestDto;
    try {
        manifest = toTrainingPromptDto(moment).grading;
    } catch {
        throw new TrainingAttemptError(
            'Training moment is not currently trainable',
            'NOT_FOUND',
            404
        );
    }
    const canonical = canonicalizeRecordedLine(
        moment.fen,
        args.request,
        manifest
    );
    const userSteps = args.request.steps.filter(
        (step) => step.actor === 'USER'
    );
    const firstUserStep = userSteps[0] ?? null;
    const comparison = canonical.comparison;

    try {
        const attempt = await db.$transaction(async (tx) => {
            await lockPracticeReviewStream({
                tx,
                userId: args.userId,
                trainingMomentId: args.momentId,
                expectedSolutionRevisionId:
                    args.request.solutionRevisionId,
            });
            const created = await tx.trainingAttempt.create({
                data: {
                    trainingMomentId: args.momentId,
                    userId: args.userId,
                    solutionRevisionId:
                        args.request.solutionRevisionId,
                    clientAttemptId:
                        args.request.clientAttemptId,
                    clientPayloadHash,
                    userMoveUci: firstUserStep?.moveUci ?? null,
                    timeSpentMs:
                        firstUserStep?.timeSpentMs ?? null,
                    status: args.request.status,
                    grade:
                        canonical.grade,
                    gradingSource:
                        canonical.gradingSource,
                    gradingEvidence: json({
                        serverVerified: true,
                        version: 1,
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
                    data: canonical.steps.map((step) => ({
                        attemptId: created.id,
                        stepIndex: step.request.stepIndex,
                        actor: step.request.actor,
                        fenBefore: step.request.fenBefore,
                        moveUci: normalizeUci(step.request.moveUci),
                        grade: step.grade,
                        evidence: json({
                            serverVerified: true,
                            source: step.source,
                            comparison: step.comparison,
                            evidence: step.evidence,
                        }),
                        timeSpentMs: step.request.timeSpentMs ?? null,
                    })),
                });
            }
            await tx.trainingMoment.updateMany({
                where: {
                    id: args.momentId,
                    userId: args.userId,
                    status: 'ACTIVE',
                    OR: [
                        { lastTrainedAt: null },
                        { lastTrainedAt: { lt: now } },
                    ],
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
                        ? canonical.grade
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
                        ? canonical.grade ?? undefined
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
                clientPayloadHash: true,
            },
        });
        if (!winner) throw error;
        assertIdempotentRecord(winner, { ...args, clientPayloadHash });
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
