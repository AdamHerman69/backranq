import { isCompleteExtractionManifest } from '@/lib/analysis/extractionManifest';
import type { Prisma } from '@prisma/client';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    mergeTrainingMomentMetadata,
    stableCanonicalStringify,
    type PovScore,
    type SolutionRevisionInput,
    type TrainingLessonKind,
    type TrainingSourceKind,
} from '@/lib/training/contracts';
import {
    solutionSemanticsHash,
    trainingMomentKey,
} from '@/lib/training/contractHashes.server';

export type TrainingMomentTransactionClient = Pick<
    Prisma.TransactionClient,
    | 'trainingMoment'
    | 'solutionRevision'
    | 'solutionMoveAssessment'
    | 'trainingMomentObservation'
    | 'analysisRun'
>;

export type PersistableTrainingMoment = {
    decisionPly: number;
    fen: string;
    positionHistory: string[];
    sideToMove: 'w' | 'b';
    originalMoveUci: string;
    originalDecision: {
        scoreBefore: PovScore;
        scoreAfter: PovScore;
        cpLoss?: number;
        winChanceLoss?: number;
    };
    confidence: number | null;
    phase: 'OPENING' | 'MIDDLEGAME' | 'ENDGAME' | null;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
    solution: SolutionRevisionInput;
};

export type PersistTrainingMomentsResult = {
    upserted: number;
    staleArchived: number;
    momentIdsByKey: Record<string, string>;
    solutionRevisionIdsByKey: Record<string, string>;
};

type PersistTrainingMomentsArgs = {
    tx: TrainingMomentTransactionClient;
    userId: string;
    gameId: string;
    sourcePgnHash: string;
    analysisRunId: string;
    analysisConfigHash: string;
    extractionManifest: ExtractionCompletionManifest;
    moments: PersistableTrainingMoment[];
};

type SelectedMoment = PersistableTrainingMoment & {
    momentKey: string;
    duplicateSolutionHashes: string[];
};

type ExistingMoment = {
    id: string;
    momentKey: string;
    sourcePgnHash: string;
    decisionPly: number;
    fen: string;
    positionHistory: string[];
    sideToMove: string;
    originalMoveUci: string;
    scoreBefore: Prisma.JsonValue;
    scoreAfter: Prisma.JsonValue;
    cpLoss: number | null;
    winChanceLoss: number | null;
    confidence: number | null;
    phase: 'OPENING' | 'MIDDLEGAME' | 'ENDGAME' | null;
    currentSolutionRevisionId: string | null;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
};

export { hashSourcePgn };

function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function normalizeUci(move: string): string {
    return move.trim().toLowerCase();
}

function assessmentPositionFenPrefix(fen: string): string {
    return fen.trim().split(/\s+/).slice(0, 5).join(' ');
}

function assertSolutionHash(solution: SolutionRevisionInput) {
    const computed = solutionSemanticsHash(solution);
    if (computed !== solution.solutionHash) {
        throw new Error('Solution hash does not match its grading semantics');
    }
    const assessmentKeys = new Set<string>();
    for (const assessment of solution.moveAssessments) {
        if (
            !assessment.positionKey.trim() ||
            !assessment.fen.trim() ||
            !assessment.positionKey.startsWith(
                `${assessmentPositionFenPrefix(assessment.fen)}|history:`
            ) ||
            !/\|history:[a-f0-9]{16}$/.test(
                assessment.positionKey
            ) ||
            !Number.isSafeInteger(assessment.decisionIndex) ||
            assessment.decisionIndex < 0
        ) {
            throw new Error('Invalid precomputed move assessment');
        }
        const key = `${assessment.decisionIndex}\u0000${assessment.positionKey}\u0000${normalizeUci(assessment.moveUci)}`;
        if (assessmentKeys.has(key)) {
            throw new Error('Duplicate precomputed move assessment');
        }
        assessmentKeys.add(key);
    }
    const rootAssessments = new Map(
        solution.moveAssessments
            .filter((assessment) => assessment.decisionIndex === 0)
            .map((assessment) => [
                normalizeUci(assessment.moveUci),
                assessment,
            ])
    );
    const acceptedMoves = Array.from(
        new Set(
            [solution.bestMoveUci, ...solution.acceptedMovesUci]
                .map(normalizeUci)
                .filter(Boolean)
        )
    );
    const frontierMoves = solution.acceptanceFrontier.moves.map(
        (move) => normalizeUci(move.moveUci)
    );
    if (
        frontierMoves.length !== acceptedMoves.length ||
        frontierMoves.some(
            (move, index) => move !== acceptedMoves[index]
        ) ||
        (solution.decision.status !== 'CONFIRMED_MISTAKE' &&
            solution.trainable) ||
        acceptedMoves.some((move) => !rootAssessments.has(move)) ||
        rootAssessments.get(normalizeUci(solution.bestMoveUci))?.grade !==
            'BEST'
    ) {
        throw new Error(
            'Every accepted root move requires a verified assessment'
        );
    }
}

function solutionRank(solution: SolutionRevisionInput): string {
    const verificationRank = {
        VERIFIED: 3,
        AMBIGUOUS: 2,
        UNSTABLE: 1,
        INVALID: 0,
    }[solution.verificationStatus];
    return [
        solution.trainable ? 1 : 0,
        verificationRank,
        solution.acceptedMovesUci.length,
        solution.bestLineUci.length,
    ]
        .map((part) => String(part).padStart(8, '0'))
        .join(':');
}

function selectDeterministicSolution(
    candidates: PersistableTrainingMoment[]
): PersistableTrainingMoment {
    return candidates
        .slice()
        .sort((left, right) => {
            const rank = solutionRank(right.solution).localeCompare(
                solutionRank(left.solution)
            );
            if (rank !== 0) return rank;
            return left.solution.solutionHash.localeCompare(
                right.solution.solutionHash
            );
        })[0]!;
}

function assertMomentEvidence(moment: PersistableTrainingMoment) {
    const { cpLoss, winChanceLoss } = moment.originalDecision;
    if (
        !Number.isSafeInteger(moment.decisionPly) ||
        moment.decisionPly < 0 ||
        !moment.fen.trim() ||
        !normalizeUci(moment.originalMoveUci) ||
        (moment.sideToMove !== 'w' && moment.sideToMove !== 'b') ||
        moment.sourceKinds.length === 0 ||
        (cpLoss !== undefined &&
            (!Number.isFinite(cpLoss) || cpLoss < 0)) ||
        (winChanceLoss !== undefined &&
            (!Number.isFinite(winChanceLoss) ||
                winChanceLoss < 0 ||
                winChanceLoss > 1)) ||
        (moment.confidence !== null &&
            (!Number.isFinite(moment.confidence) ||
                moment.confidence < 0 ||
                moment.confidence > 1))
    ) {
        throw new Error('Invalid original-decision training evidence');
    }
}

function groupMoments(args: {
    gameId: string;
    sourcePgnHash: string;
    moments: PersistableTrainingMoment[];
}): SelectedMoment[] {
    const grouped = new Map<string, PersistableTrainingMoment[]>();
    for (const moment of args.moments) {
        assertMomentEvidence(moment);
        assertSolutionHash(moment.solution);
        const momentKey = trainingMomentKey({
            gameId: args.gameId,
            sourcePgnHash: args.sourcePgnHash,
            decisionPly: moment.decisionPly,
        });
        const current = grouped.get(momentKey) ?? [];
        if (
            current.some(
                (candidate) =>
                    candidate.solution.solutionHash !==
                    moment.solution.solutionHash
            )
        ) {
            throw new Error(
                'Conflicting solution hashes share one training moment identity'
            );
        }
        current.push(moment);
        grouped.set(momentKey, current);
    }

    return Array.from(grouped, ([momentKey, candidates]) => {
        const first = candidates[0]!;
        for (const candidate of candidates.slice(1)) {
            if (
                candidate.fen !== first.fen ||
                candidate.sideToMove !== first.sideToMove ||
                normalizeUci(candidate.originalMoveUci) !==
                    normalizeUci(first.originalMoveUci) ||
                stableCanonicalStringify(candidate.originalDecision) !==
                    stableCanonicalStringify(first.originalDecision)
            ) {
                throw new Error(
                    'Conflicting positions share one training moment identity'
                );
            }
        }

        const selected = selectDeterministicSolution(candidates);
        const metadata = mergeTrainingMomentMetadata(
            ...candidates.map((candidate) => ({
                sourceKinds: candidate.sourceKinds,
                lessonKinds: candidate.lessonKinds,
                themes: candidate.themes,
            }))
        );
        return {
            ...selected,
            ...metadata,
            momentKey,
            duplicateSolutionHashes: Array.from(
                new Set(
                    candidates.map(
                        (candidate) => candidate.solution.solutionHash
                    )
                )
            ).sort(),
        };
    }).sort((left, right) => left.decisionPly - right.decisionPly);
}

function revisionCreateData(args: {
    momentId: string;
    analysisRunId: string;
    revision: number;
    solution: SolutionRevisionInput;
    duplicateSolutionHashes: string[];
    originalDecision: unknown;
}): Prisma.SolutionRevisionUncheckedCreateInput {
    const solution = args.solution;
    return {
        momentId: args.momentId,
        analysisRunId: args.analysisRunId,
        revision: args.revision,
        solutionHash: solution.solutionHash,
        verificationStatus: solution.verificationStatus,
        solutionShape: solution.solutionShape,
        gradingStrategy: solution.gradingStrategy,
        continuationShape: solution.continuationShape,
        trainable: solution.trainable,
        bestMoveUci: normalizeUci(solution.bestMoveUci),
        acceptedMovesUci: Array.from(
            new Set(
                [solution.bestMoveUci, ...solution.acceptedMovesUci]
                    .map(normalizeUci)
                    .filter(Boolean)
            )
        ),
        acceptanceFrontier: json(solution.acceptanceFrontier),
        decision: json(solution.decision),
        answerCoverage: json(solution.answerCoverage),
        continuation: json(solution.continuation),
        originalDecision: json(args.originalDecision),
        bestLine: json(solution.bestLineUci.map(normalizeUci)),
        solutionTree: json(solution.solutionTree),
        scoreAtStart:
            solution.scoreAtStart == null
                ? undefined
                : json(solution.scoreAtStart),
        playedMoveScore:
            solution.playedMoveScore == null
                ? undefined
                : json(solution.playedMoveScore),
        targetOutcome: json(solution.targetOutcome),
        gradingPolicy: json(solution.gradingPolicy),
        evidence: json({
            selected: solution.evidence,
            candidateSolutionHashes: args.duplicateSolutionHashes,
        }),
        generatorVersion: solution.generatorVersion,
        configHash: solution.configHash,
    };
}

async function nextRevision(
    tx: TrainingMomentTransactionClient,
    momentId: string
): Promise<number> {
    const latest = await tx.solutionRevision.findFirst({
        where: { momentId },
        orderBy: { revision: 'desc' },
        select: { revision: true },
    });
    return (latest?.revision ?? 0) + 1;
}

async function assertCurrentRevisionBelongsToMoment(
    tx: TrainingMomentTransactionClient,
    moment: ExistingMoment
) {
    if (!moment.currentSolutionRevisionId) return null;
    const current = await tx.solutionRevision.findUnique({
        where: { id: moment.currentSolutionRevisionId },
        select: { id: true, momentId: true, solutionHash: true, configHash: true, generatorVersion: true, originalDecision: true, evidence: true, verificationStatus: true, trainable: true },
    });
    if (!current || current.momentId !== moment.id) {
        throw new Error(
            'Current solution revision does not belong to its training moment'
        );
    }
    return current;
}

async function appendOrReuseRunRevision(args: {
    tx: TrainingMomentTransactionClient;
    momentId: string;
    analysisRunId: string;
    solution: SolutionRevisionInput;
    duplicateSolutionHashes: string[];
    momentMetadata: {
        sourceKinds: TrainingSourceKind[];
        lessonKinds: TrainingLessonKind[];
        themes: string[];
    };
    originalDecision: unknown;
    currentRevision: {
        id: string;
        momentId: string;
        solutionHash: string;
        configHash: string;
        generatorVersion: string;
        originalDecision: unknown;
        evidence: unknown;
        verificationStatus: string;
        trainable: boolean;
    } | null;
}) {
    const observation = await args.tx.trainingMomentObservation.findUnique({
        where: {
            momentId_analysisRunId: {
                momentId: args.momentId,
                analysisRunId: args.analysisRunId,
            },
        },
        select: {
            solutionRevisionId: true,
            observedSolutionHash: true,
            solutionRevision: { select: { configHash: true, generatorVersion: true, originalDecision: true, evidence: true } },
        },
    });
    if (observation) {
        if (
            observation.observedSolutionHash !==
            args.solution.solutionHash
        ) {
            throw new Error(
                'Analysis run already observed different solution semantics'
            );
        }
        const pinned = observation.solutionRevision;
        if (!pinned || pinned.configHash !== args.solution.configHash ||
            pinned.generatorVersion !== args.solution.generatorVersion ||
            stableCanonicalStringify(pinned.originalDecision) !== stableCanonicalStringify(args.originalDecision) ||
            stableCanonicalStringify((pinned.evidence as {selected?: unknown})?.selected) !== stableCanonicalStringify(args.solution.evidence)) {
            throw new Error('Analysis run already observed different immutable evidence');
        }
        return {
            revision: {
                id: observation.solutionRevisionId,
                momentId: args.momentId,
                solutionHash: observation.observedSolutionHash,
            },
            created: false,
        };
    }
    let revision: {
        id: string;
        momentId: string;
        solutionHash: string;
    };
    let created = false;
    if (
        args.currentRevision?.momentId === args.momentId &&
        args.currentRevision.solutionHash === args.solution.solutionHash &&
        args.currentRevision.configHash === args.solution.configHash &&
        args.currentRevision.generatorVersion === args.solution.generatorVersion &&
        stableCanonicalStringify(args.currentRevision.originalDecision) === stableCanonicalStringify(args.originalDecision) &&
        stableCanonicalStringify((args.currentRevision.evidence as {selected?: unknown})?.selected) === stableCanonicalStringify(args.solution.evidence)
    ) {
        revision = args.currentRevision;
    } else {
        revision = await args.tx.solutionRevision.create({
            data: revisionCreateData({
                momentId: args.momentId,
                analysisRunId: args.analysisRunId,
                revision: await nextRevision(args.tx, args.momentId),
                solution: args.solution,
                duplicateSolutionHashes: args.duplicateSolutionHashes,
                originalDecision: args.originalDecision,
            }),
            select: {
                id: true,
                momentId: true,
                solutionHash: true,
            },
        });
        created = true;
        await args.tx.solutionMoveAssessment.createMany({
            data: args.solution.moveAssessments.map((assessment) => ({
                solutionRevisionId: revision.id,
                positionKey: assessment.positionKey,
                referenceId: assessment.referenceId,
                tierStable: assessment.tierStable,
                decisionIndex: assessment.decisionIndex,
                fen: assessment.fen,
                moveUci: normalizeUci(assessment.moveUci),
                source: assessment.source,
                status: 'VERIFIED',
                grade: assessment.grade,
                scoreAfter:
                    assessment.scoreAfter == null
                        ? undefined
                        : json(assessment.scoreAfter),
                evidence: json(assessment.evidence),
            })),
        });
    }
    await args.tx.trainingMomentObservation.create({
        data: {
            momentId: args.momentId,
            analysisRunId: args.analysisRunId,
            solutionRevisionId: revision.id,
            observedSolutionHash: args.solution.solutionHash,
            evidence: json({
                verificationStatus: args.solution.verificationStatus,
                candidateSolutionHashes: args.duplicateSolutionHashes,
                sourceKinds: args.momentMetadata.sourceKinds,
                lessonKinds: args.momentMetadata.lessonKinds,
                themes: args.momentMetadata.themes,
                extraction: args.solution.evidence,
            }),
        },
    });
    return { revision, created };
}

export async function persistTrainingMomentsInTransaction(
    args: PersistTrainingMomentsArgs
): Promise<PersistTrainingMomentsResult> {
    if (!args.sourcePgnHash.trim()) {
        throw new Error('sourcePgnHash is required for training persistence');
    }
    const manifest = args.extractionManifest;
    if (
        !isCompleteExtractionManifest(manifest) ||
        manifest.version !== 1 ||
        manifest.complete !== true ||
        manifest.sourceGameId !== args.gameId ||
        manifest.sourcePgnHash !== args.sourcePgnHash ||
        manifest.termination !== 'COMPLETED' ||
        manifest.scannedPlies !== manifest.expectedPlies ||
        manifest.scannedPlies < 0 ||
        !Number.isSafeInteger(manifest.scannedPlies) ||
        manifest.errors.length !== 0
    ) {
        throw new Error(
            'Complete extraction manifest is required before persistence'
        );
    }
    if (
        args.moments.some(
            (moment) =>
                moment.solution.configHash !== args.analysisConfigHash
        )
    ) {
        throw new Error(
            'Training solution config does not match its analysis run'
        );
    }
    const analysisRun = await args.tx.analysisRun.findFirst({
        where: {
            id: args.analysisRunId,
            userId: args.userId,
            gameId: args.gameId,
            inputPgnHash: args.sourcePgnHash,
            configHash: args.analysisConfigHash,
            status: 'RUNNING',
        },
        select: { id: true },
    });
    if (!analysisRun) {
        throw new Error(
            'Analysis run provenance does not match training persistence'
        );
    }
    const selectedMoments = groupMoments(args);
    const momentIdsByKey: Record<string, string> = {};
    const solutionRevisionIdsByKey: Record<string, string> = {};

    for (const selected of selectedMoments) {
        const existing = (await args.tx.trainingMoment.findUnique({
            where: { momentKey: selected.momentKey },
            select: {
                id: true,
                momentKey: true,
                sourcePgnHash: true,
                decisionPly: true,
                fen: true,
                positionHistory: true,
                sideToMove: true,
                originalMoveUci: true,
                scoreBefore: true,
                scoreAfter: true,
                cpLoss: true,
                winChanceLoss: true,
                confidence: true,
                phase: true,
                currentSolutionRevisionId: true,
                sourceKinds: true,
                lessonKinds: true,
                themes: true,
            },
        })) as ExistingMoment | null;
        if (
            existing &&
            (existing.sourcePgnHash !== args.sourcePgnHash ||
                existing.decisionPly !== selected.decisionPly ||
                existing.fen !== selected.fen ||
                stableCanonicalStringify(existing.positionHistory) !==
                    stableCanonicalStringify(
                        selected.positionHistory
                    ) ||
                existing.sideToMove !== selected.sideToMove ||
                normalizeUci(existing.originalMoveUci) !==
                    normalizeUci(selected.originalMoveUci))
        ) {
            throw new Error(
                'Stored training moment does not match its canonical identity'
            );
        }
        const currentRevision = existing
            ? await assertCurrentRevisionBelongsToMoment(args.tx, existing)
            : null;

        const metadata = mergeTrainingMomentMetadata(selected);
        const unresolved = selected.solution.decision.status === 'UNRESOLVED';
        const disproved = selected.solution.decision.status === 'NOT_A_MISTAKE';
        const preserveCurrent = unresolved && currentRevision?.trainable === true && currentRevision.verificationStatus === 'VERIFIED';
        const status = disproved ? 'ARCHIVED' : unresolved
            ? preserveCurrent && currentRevision.configHash === args.analysisConfigHash ? 'ACTIVE' : 'UNSTABLE'
            : selected.solution.trainable ? 'ACTIVE' : 'UNSTABLE';
        const archivedAt = disproved ? new Date() : null;
        const moment = await args.tx.trainingMoment.upsert({
            where: { momentKey: selected.momentKey },
            create: {
                userId: args.userId,
                gameId: args.gameId,
                momentKey: selected.momentKey,
                sourcePgnHash: args.sourcePgnHash,
                decisionPly: selected.decisionPly,
                fen: selected.fen,
                positionHistory: selected.positionHistory,
                sideToMove: selected.sideToMove,
                originalMoveUci: normalizeUci(selected.originalMoveUci),
                scoreBefore: json(selected.originalDecision.scoreBefore),
                scoreAfter: json(selected.originalDecision.scoreAfter),
                cpLoss: selected.originalDecision.cpLoss,
                winChanceLoss: selected.originalDecision.winChanceLoss,
                confidence: selected.confidence,
                phase: selected.phase,
                status,
                sourceKinds: metadata.sourceKinds,
                lessonKinds: metadata.lessonKinds,
                themes: metadata.themes,
                archivedAt,
            },
            update: preserveCurrent ? { status, archivedAt } : {
                status,
                scoreBefore: json(selected.originalDecision.scoreBefore),
                scoreAfter: json(selected.originalDecision.scoreAfter),
                cpLoss: selected.originalDecision.cpLoss ?? null,
                winChanceLoss: selected.originalDecision.winChanceLoss ?? null,
                confidence: selected.confidence,
                phase: selected.phase,
                positionHistory: selected.positionHistory,
                sourceKinds: metadata.sourceKinds,
                lessonKinds: metadata.lessonKinds,
                themes: metadata.themes,
                archivedAt,
            },
            select: { id: true },
        });

        const revisionResult = await appendOrReuseRunRevision({
            tx: args.tx,
            momentId: moment.id,
            analysisRunId: args.analysisRunId,
            solution: selected.solution,
            duplicateSolutionHashes: selected.duplicateSolutionHashes,
            momentMetadata: {
                sourceKinds: selected.sourceKinds,
                lessonKinds: selected.lessonKinds,
                themes: selected.themes,
            },
            originalDecision: {
                ...selected.originalDecision,
                fen: selected.fen,
                positionHistory: selected.positionHistory,
                originalMoveUci: selected.originalMoveUci,
                sideToMove: selected.sideToMove,
                sourceKinds: selected.sourceKinds,
                lessonKinds: selected.lessonKinds,
                themes: selected.themes,
                confidence: selected.confidence,
                phase: selected.phase,
            },
            currentRevision,
        });
        const revision = revisionResult.revision;
        if (revision.momentId !== moment.id) {
            throw new Error(
                'Solution revision does not belong to its training moment'
            );
        }
        if (!preserveCurrent) {
            await args.tx.trainingMoment.update({
                where: { id: moment.id },
                data: { currentSolutionRevisionId: revision.id },
            });
        }

        momentIdsByKey[selected.momentKey] = moment.id;
        solutionRevisionIdsByKey[selected.momentKey] = revision.id;
    }

    // Absence is not a negative conclusion: reconcile only explicitly assessed
    // decisions, with source identity pinned to this run.
    const rejectedPlies = manifest.decisionOutcomes
        .filter(outcome => outcome.status === 'NOT_A_MISTAKE')
        .map(outcome => outcome.decisionPly)
        .filter(ply => !selectedMoments.some(moment => moment.decisionPly === ply));
    const staleArchived = rejectedPlies.length === 0 ? { count: 0 } :
        await args.tx.trainingMoment.updateMany({
            where: {
                userId: args.userId,
                gameId: args.gameId,
                sourcePgnHash: args.sourcePgnHash,
                decisionPly: { in: rejectedPlies },
                archivedAt: null,
            },
            data: { archivedAt: new Date(), status: 'ARCHIVED' },
        });
    const unresolvedPlies = manifest.decisionOutcomes
        .filter(outcome => outcome.status === 'UNRESOLVED')
        .map(outcome => outcome.decisionPly);
    if (unresolvedPlies.length > 0) {
        // Prior same-policy proof remains usable. An incompatible prior policy
        // keeps its history, but must not serve current authoritative verdicts.
        await args.tx.trainingMoment.updateMany({
            where: {
                userId: args.userId,
                gameId: args.gameId,
                sourcePgnHash: args.sourcePgnHash,
                decisionPly: { in: unresolvedPlies },
                archivedAt: null,
                currentSolutionRevision: { is: { configHash: { not: args.analysisConfigHash } } },
            },
            data: { status: 'UNSTABLE' },
        });
    }

    return {
        upserted: selectedMoments.length,
        staleArchived: staleArchived.count,
        momentIdsByKey,
        solutionRevisionIdsByKey,
    };
}
