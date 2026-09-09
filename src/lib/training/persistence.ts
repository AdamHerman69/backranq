import { CORROBORATED_SELECTION_POLICY_ID } from './selectionPolicy';
import { originalDecisionForPracticeManifest, practiceProfileMatchesConfig } from './practiceSourceBinding';
import { randomUUID } from 'node:crypto';
import { isCompleteExtractionManifest } from '@/lib/analysis/extractionManifest';
import type { Prisma } from '@prisma/client';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { parsePracticeMomentRevision, type PracticeMomentRevision } from './practiceContract';
import {
    mergeTrainingMomentMetadata,
    isTrainableSolution,
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
    /** Supplied canonical revisions that are currently trainable, excluding retired/omitted moments. */
    upserted: number;
    /** Existing moments newly archived by supplied canonical negative evidence. */
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
    archivedAt: Date | null;
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

function assertSolutionHash(solution: SolutionRevisionInput) {
    parsePracticeMomentRevision(solution.manifest);
    if (solutionSemanticsHash(solution) !== solution.manifest.semanticHash) {
        throw new Error('Solution hash does not match its grading semantics');
    }
}

function solutionRank(solution: SolutionRevisionInput): string {
    return [isTrainableSolution(solution) ? 1 : 0,
        solution.manifest.assessments.filter(item => item.qualitySupport === 'SUPPORTED').length]
        .map(value => String(value).padStart(8, '0')).join(':');
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
            return left.solution.manifest.semanticHash.localeCompare(
                right.solution.manifest.semanticHash
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
        const source = moment.solution.manifest.source;
        if (source.gameId !== args.gameId || source.sourcePgnHash !== args.sourcePgnHash
            || source.decisionPly !== moment.decisionPly || source.fen !== moment.fen
            || source.originalMoveUci !== moment.originalMoveUci
            || (source.trainingSide === 'WHITE' ? 'w' : 'b') !== moment.sideToMove
            || stableCanonicalStringify(source.positionHistory) !== stableCanonicalStringify(moment.positionHistory)
            || stableCanonicalStringify(originalDecisionForPracticeManifest(moment.solution.manifest)) !== stableCanonicalStringify(moment.originalDecision)) {
            throw new Error('Training moment source does not match its practice manifest');
        }
        const momentKey = trainingMomentKey({
            gameId: args.gameId,
            sourcePgnHash: args.sourcePgnHash,
            decisionPly: moment.decisionPly,
        });
        const current = grouped.get(momentKey) ?? [];
        if (
            current.some(
                (candidate) =>
                    candidate.solution.manifest.semanticHash !==
                    moment.solution.manifest.semanticHash
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
                        (candidate) => candidate.solution.manifest.semanticHash
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
    const id = randomUUID();
    const solution = args.solution;
    return {
        id, momentId: args.momentId, analysisRunId: args.analysisRunId, revision: args.revision,
        solutionHash: solution.manifest.semanticHash, trainable: isTrainableSolution(solution),
        manifest: json({ ...solution.manifest, momentId: args.momentId, revisionId: id }),
        generatorVersion: solution.manifest.generatorVersion, configHash: solution.configHash,
    };
}

function sameImmutableEvidence(manifest: unknown, solution: SolutionRevisionInput): boolean {
    const stored = manifest as PracticeMomentRevision;
    return stableCanonicalStringify(stored.evidence) === stableCanonicalStringify(solution.manifest.evidence)
        && stableCanonicalStringify(stored.source) === stableCanonicalStringify(solution.manifest.source);
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
        select: { id: true, momentId: true, solutionHash: true, configHash: true, generatorVersion: true, manifest: true, trainable: true },
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
        manifest: unknown;
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
            solutionRevision: { select: { configHash: true, generatorVersion: true, manifest: true } },
        },
    });
    if (observation) {
        if (
            observation.observedSolutionHash !==
            args.solution.manifest.semanticHash
        ) {
            throw new Error(
                'Analysis run already observed different solution semantics'
            );
        }
        const pinned = observation.solutionRevision;
        if (!pinned || pinned.configHash !== args.solution.configHash ||
            pinned.generatorVersion !== args.solution.manifest.generatorVersion ||
            !sameImmutableEvidence(pinned.manifest, args.solution)) {
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
        args.currentRevision.solutionHash === args.solution.manifest.semanticHash &&
        args.currentRevision.configHash === args.solution.configHash &&
        args.currentRevision.generatorVersion === args.solution.manifest.generatorVersion &&
        sameImmutableEvidence(args.currentRevision.manifest, args.solution)
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

    }
    await args.tx.trainingMomentObservation.create({
        data: {
            momentId: args.momentId,
            analysisRunId: args.analysisRunId,
            solutionRevisionId: revision.id,
            observedSolutionHash: args.solution.manifest.semanticHash,
            evidence: json({
                decision: args.solution.manifest.decision,
                candidateSolutionHashes: args.duplicateSolutionHashes,
                sourceKinds: args.momentMetadata.sourceKinds,
                lessonKinds: args.momentMetadata.lessonKinds,
                themes: args.momentMetadata.themes,
                extraction: args.solution.manifest.evidence,
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
        select: { id: true, configSnapshot: true },
    });
    if (!analysisRun) {
        throw new Error(
            'Analysis run provenance does not match training persistence'
        );
    }
    if (args.moments.some(moment => !practiceProfileMatchesConfig(moment.solution.manifest, args.analysisConfigHash, analysisRun.configSnapshot))) {
        throw new Error('Practice profile does not match its analysis run configuration');
    }
    const selectedMoments = groupMoments(args);
    for (const selected of selectedMoments) {
        const diagnostic = manifest.decisionOutcomes.find(outcome => outcome.decisionPly === selected.decisionPly);
        if (diagnostic && diagnostic.status !== selected.solution.manifest.decision.status) {
            throw new Error('Diagnostic outcome contradicts its canonical practice decision');
        }
    }
    let staleArchived = 0;
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
                archivedAt: true,
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
        const included = isTrainableSolution(selected.solution);
        const corroborated = selected.solution.manifest.selection.policyId === CORROBORATED_SELECTION_POLICY_ID;
        const unresolved = !included && corroborated && selected.solution.manifest.decision.status === 'UNRESOLVED';
        const disproved = !included && !unresolved
            && (!corroborated || selected.solution.manifest.decision.status === 'NOT_A_MISTAKE');
        const preserveCurrent = unresolved && currentRevision?.trainable === true;
        const status = disproved ? 'ARCHIVED' : unresolved
            ? preserveCurrent && currentRevision.configHash === args.analysisConfigHash ? 'ACTIVE' : 'UNSTABLE'
            : included ? 'ACTIVE' : 'UNSTABLE';
        const archivedAt = disproved ? new Date() : null;
        if (disproved && existing && existing.archivedAt === null) staleArchived++;
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

    // Completion outcomes are diagnostics, not independently validated verdicts.
    // Only the canonical revisions processed above may archive or suspend a moment.

    return {
        upserted: selectedMoments.filter(moment => isTrainableSolution(moment.solution)).length,
        staleArchived,
        momentIdsByKey,
        solutionRevisionIdsByKey,
    };
}
