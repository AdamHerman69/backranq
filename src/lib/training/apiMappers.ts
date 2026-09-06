import type {
    TrainingComparisonDto,
    TrainingGradingManifestDto,
    TrainingMoveAssessmentDto,
    TrainingPromptDto,
    TrainingReviewDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import type {
    AttemptGrade,
    AcceptanceFrontier,
    GradingPolicyV3,
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';
import { gameSourceToUi } from '@/lib/games/dbMappings';
import type { GameSource } from '@prisma/client';
import { assessmentPositionKey, appendAssessmentHistory } from './assessmentIdentity';
import { answerCoverage, continuationReadiness, decisionAssessment } from './evidenceContract';

export function toTrainingPromptDto(row: {
    id: string;
    currentSolutionRevisionId: string | null;
    fen: string;
    sideToMove: string;
    positionHistory: string[];
    originalMoveUci: string;
    scoreBefore: unknown;
    scoreAfter: unknown;
    cpLoss: number | null;
    winChanceLoss: number | null;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
    gameId: string;
    decisionPly: number;
    game: {
        provider: GameSource;
        playedAt: Date;
    };
    currentSolutionRevision: {
        bestMoveUci: string;
        acceptedMovesUci: string[];
        acceptanceFrontier: unknown;
        decision: unknown;
        answerCoverage: unknown;
        continuation: unknown;
        originalDecision: unknown;
        solutionShape: 'UNIQUE' | 'MULTIPLE' | 'OPEN';
        bestLine: unknown;
        scoreAtStart: unknown;
        gradingPolicy: unknown;
        solutionTree: unknown;
        moveAssessments: Array<{
            positionKey: string;
            referenceId: string;
            tierStable: boolean;
            decisionIndex: number;
            fen: string;
            moveUci: string;
            source: 'PRECOMPUTED' | 'DYNAMIC' | 'CLIENT_EVALUATED' | 'TABLEBASE';
            status: 'PENDING' | 'VERIFIED' | 'FAILED';
            grade: AttemptGrade | null;
            scoreAfter: unknown;
            evidence: unknown;
        }>;
    } | null;
}): TrainingPromptDto {
    if (
        !row.currentSolutionRevisionId ||
        !row.currentSolutionRevision ||
        (row.sideToMove !== 'w' && row.sideToMove !== 'b')
    ) {
        throw new Error('Training prompt is missing canonical state');
    }
    const revision = row.currentSolutionRevision;
    const original = revision.originalDecision as Record<string, unknown>;
    const originalScoreAfter = nullablePovScore(original?.scoreAfter);
    const gradingPolicy = gradingPolicyV3(
        revision.gradingPolicy
    );
    const acceptanceFrontier = acceptanceFrontierDto(
        revision.acceptanceFrontier
    );
    const solutionTree = trainingSolutionTreeDto(revision.solutionTree, row.positionHistory);
    const decision = decisionAssessment(revision.decision);
    const continuation = continuationReadiness(revision.continuation);
    const coverage = gradingPolicy && answerCoverage(revision.answerCoverage, {
        fen: row.fen,
        positionHistory: row.positionHistory,
        policyVersion: gradingPolicy.version,
        acceptedMovesUci: revision.acceptedMovesUci,
    });
    if (coverage && !solutionTree.answerCoverage) solutionTree.answerCoverage = coverage;
    const frontierMoves = acceptanceFrontier?.moves.map(
        (move) => move.moveUci
    ) ?? [];
    const moveAssessments = revision.moveAssessments
        .filter(
            (
                assessment
            ): assessment is typeof assessment & {
                status: 'VERIFIED';
                source: 'PRECOMPUTED' | 'TABLEBASE';
                grade: AttemptGrade;
            } =>
                assessment.status === 'VERIFIED' &&
                assessment.grade != null &&
                (assessment.source === 'PRECOMPUTED' || assessment.source === 'TABLEBASE')
        )
        .map(
            (assessment): TrainingMoveAssessmentDto => ({
                positionKey: assessment.positionKey,
                referenceId: assessment.referenceId,
                tierStable: assessment.tierStable,
                decisionIndex: assessment.decisionIndex,
                fen: assessment.fen,
                moveUci: assessment.moveUci,
                source: assessment.source,
                grade: assessment.grade,
                scoreAfter: nullablePovScore(assessment.scoreAfter),
                evidence: assessment.evidence,
            })
        );
    if (
        !originalScoreAfter ||
        !gradingPolicy ||
        !acceptanceFrontier ||
        !decision || decision.status !== 'CONFIRMED_MISTAKE' ||
        !continuation || !coverage ||
        solutionTree.contextId !== coverage.contextId ||
        frontierMoves.length === 0 ||
        frontierMoves[0] !== revision.bestMoveUci ||
        acceptanceFrontier.moves[0]?.tier !== 'BEST' ||
        frontierMoves.length !==
            revision.acceptedMovesUci.length ||
        frontierMoves.length !==
            solutionTree.acceptedMovesUci.length ||
        !hasSupportedLocalGradingTree(solutionTree, moveAssessments, gradingPolicy.version) ||
        frontierMoves.some(
            (move, index) =>
                move !== revision.acceptedMovesUci[index] ||
                move !== solutionTree.acceptedMovesUci[index] ||
                moveAssessments.find(
                    (assessment) =>
                        assessment.decisionIndex === 0 &&
                        assessment.positionKey === coverage.contextId &&
                        assessment.fen === row.fen &&
                        assessment.moveUci === move
                )?.grade !== acceptanceFrontier.moves[index]?.tier
        )
    ) {
        throw new Error('Training prompt has invalid grading evidence');
    }
    const review = toTrainingReviewDto({
        moment: row,
        revision,
        submittedMoveUci: null,
        comparison: null,
    });
    const grading: TrainingGradingManifestDto = {
        version: 1,
        decision,
        answerCoverage: coverage,
        continuation,
        trainingSide: row.sideToMove,
        positionHistory: row.positionHistory,
        originalMoveUci: row.originalMoveUci,
        originalScoreAfter,
        gradingPolicy,
        acceptanceFrontier,
        solutionTree,
        moveAssessments,
        review,
    };
    return {
        id: row.id,
        solutionRevisionId: row.currentSolutionRevisionId,
        fen: row.fen,
        sideToMove: row.sideToMove,
        grading,
    };
}

function hasSupportedLocalGradingTree(
    node: TrainingSolutionTreeNodeDto,
    assessments: TrainingMoveAssessmentDto[],
    policyVersion: number
): boolean {
    if (node.role === 'USER') {
        const coverage = answerCoverage(node.answerCoverage, {
            fen: node.fen, positionHistory: node.positionHistory,
            policyVersion, acceptedMovesUci: node.acceptedMovesUci,
        });
        if (!coverage) return false;
        const rows = assessments.filter(row => row.positionKey === node.contextId && row.decisionIndex === Math.floor(node.ply / 2));
        if (rows.length !== coverage.assessedMovesUci.length || rows.some(row =>
            row.referenceId !== coverage.referenceId || !coverage.assessedMovesUci.includes(row.moveUci))) return false;
        const branchMoves = node.branches.map(
            (branch) => branch.moveUci
        );
        if (
            node.acceptedMovesUci.length === 0 ||
            (branchMoves.length > 0 && branchMoves.length !== node.acceptedMovesUci.length) ||
            node.acceptedMovesUci.some(
                (move, index) => branchMoves.length > 0 && move !== branchMoves[index]
            ) ||
            node.acceptedMovesUci.some(
                (move) =>
                    !assessments.some(
                        (assessment) =>
                            assessment.decisionIndex ===
                                Math.floor(node.ply / 2) &&
                            assessment.positionKey === node.contextId &&
                            assessment.fen === node.fen &&
                            assessment.moveUci === move &&
                            (assessment.grade === 'BEST' ||
                                assessment.grade === 'STRONG' ||
                                assessment.grade === 'GOOD')
                    )
            )
        ) {
            return false;
        }
    }
    if (
        node.role === 'OPPONENT' &&
        (node.acceptedMovesUci.length !== 0 ||
            node.branches.length > 1 ||
            (node.branches.length === 1 &&
                node.selectedMoveUci !==
                    node.branches[0]?.moveUci))
    ) {
        return false;
    }
    if (
        node.role === 'TERMINAL' &&
        (node.acceptedMovesUci.length !== 0 ||
            node.branches.length !== 0)
    ) {
        return false;
    }
    return node.branches.every((branch) =>
        hasSupportedLocalGradingTree(branch.child, assessments, policyVersion)
    );
}

function gradingPolicyV3(value: unknown): GradingPolicyV3 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const policy = value as Partial<GradingPolicyV3>;
    return policy.version === 3 &&
        policy.pov === 'TRAINING_SIDE' &&
        policy.unknownMove === 'EVALUATE' &&
        policy.matePolicy === 'EXACT' &&
        policy.tablebasePolicy === 'EXACT' &&
        !!policy.best &&
        !!policy.strong &&
        !!policy.success &&
        !!policy.improvement
        ? (policy as GradingPolicyV3)
        : null;
}

function acceptanceFrontierDto(
    value: unknown
): AcceptanceFrontier | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const frontier = value as Partial<AcceptanceFrontier>;
    if (
        frontier.version !== 1 ||
        (frontier.status !== 'STABLE' &&
            frontier.status !== 'OPEN' &&
            frontier.status !== 'UNSTABLE') ||
        !Array.isArray(frontier.moves)
    ) {
        return null;
    }
    return frontier as AcceptanceFrontier;
}

function trainingSolutionTreeDto(
    value: unknown,
    expectedHistory: string[]
): TrainingSolutionTreeNodeDto {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Training prompt has an invalid solution tree');
    }
    const node = value as Record<string, unknown>;
    if (
        typeof node.fen !== 'string' ||
        typeof node.contextId !== 'string' ||
        !Array.isArray(node.positionHistory) ||
        !node.positionHistory.every(fen => typeof fen === 'string') ||
        !Number.isSafeInteger(node.ply) ||
        (node.role !== 'USER' &&
            node.role !== 'OPPONENT' &&
            node.role !== 'TERMINAL') ||
        !Array.isArray(node.branches)
    ) {
        throw new Error('Training prompt has an invalid solution tree');
    }
    if (JSON.stringify(node.positionHistory) !== JSON.stringify(expectedHistory) || node.contextId !== assessmentPositionKey(node.fen, expectedHistory)) {
        throw new Error('Training prompt has an invalid history context');
    }
    return {
        contextId: node.contextId,
        positionHistory: node.positionHistory as string[],
        ...(node.answerCoverage ? { answerCoverage: node.answerCoverage as import('./contracts').AnswerCoverage } : {}),
        fen: node.fen,
        ply: node.ply as number,
        role: node.role,
        acceptedMovesUci: Array.isArray(node.acceptedMovesUci)
            ? node.acceptedMovesUci.filter(
                  (move): move is string => typeof move === 'string'
              )
            : [],
        ...(typeof node.selectedMoveUci === 'string'
            ? { selectedMoveUci: node.selectedMoveUci }
            : {}),
        ...(typeof node.alternativesComplete === 'boolean'
            ? {
                  alternativesComplete:
                      node.alternativesComplete,
              }
            : {}),
        ...(typeof node.stopReason === 'string'
            ? { stopReason: node.stopReason }
            : {}),
        branches: node.branches.map((rawBranch) => {
            if (
                !rawBranch ||
                typeof rawBranch !== 'object' ||
                Array.isArray(rawBranch)
            ) {
                throw new Error(
                    'Training prompt has an invalid solution branch'
                );
            }
            const branch = rawBranch as Record<string, unknown>;
            if (
                typeof branch.moveUci !== 'string' ||
                typeof branch.best !== 'boolean'
            ) {
                throw new Error(
                    'Training prompt has an invalid solution branch'
                );
            }
            return {
                moveUci: branch.moveUci,
                best: branch.best,
                child: trainingSolutionTreeDto(branch.child, appendAssessmentHistory(expectedHistory, node.fen as string)),
            };
        }),
    };
}

export function isPovScore(value: unknown): value is PovScore {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const score = value as Record<string, unknown>;
    if (score.kind === 'cp') {
        return (
            score.pov === 'WHITE' &&
            typeof score.cp === 'number' &&
            Number.isFinite(score.cp)
        );
    }
    if (score.kind === 'mate') {
        return (
            (score.winner === 'WHITE' || score.winner === 'BLACK') &&
            typeof score.plies === 'number' &&
            Number.isSafeInteger(score.plies) &&
            score.plies >= 0
        );
    }
    if (score.kind === 'tablebase') {
        return (
            score.pov === 'WHITE' &&
            (score.wdl === 'WIN' ||
                score.wdl === 'DRAW' ||
                score.wdl === 'LOSS') &&
            (score.dtz === undefined ||
                (typeof score.dtz === 'number' &&
                    Number.isFinite(score.dtz)))
        );
    }
    return false;
}

export function nullablePovScore(value: unknown): PovScore | null {
    return isPovScore(value) ? value : null;
}

export function toTrainingReviewDto(args: {
    moment: {
        id: string;
        gameId: string;
        decisionPly: number;
        sideToMove: string;
        originalMoveUci: string;
        scoreBefore: unknown;
        scoreAfter: unknown;
        cpLoss: number | null;
        winChanceLoss: number | null;
        sourceKinds: TrainingSourceKind[];
        lessonKinds: TrainingLessonKind[];
        themes: string[];
        game: {
            provider: GameSource;
            playedAt: Date;
        };
    };
    revision: {
        bestMoveUci: string;
        acceptedMovesUci: string[];
        acceptanceFrontier: unknown;
        answerCoverage: unknown;
        originalDecision: unknown;
        solutionShape: 'UNIQUE' | 'MULTIPLE' | 'OPEN';
        bestLine: unknown;
        scoreAtStart: unknown;
    };
    submittedMoveUci: string | null;
    comparison: TrainingComparisonDto | null;
}): TrainingReviewDto {
    const original = args.revision.originalDecision as Record<string, unknown>;
    const scoreBefore = nullablePovScore(original?.scoreBefore);
    const scoreAfter = nullablePovScore(original?.scoreAfter);
    if (!scoreBefore || !scoreAfter) {
        throw new Error('Training moment has invalid original-decision scores');
    }
    if (
        args.moment.sideToMove !== 'w' &&
        args.moment.sideToMove !== 'b'
    ) {
        throw new Error('Training moment has invalid side to move');
    }
    return {
        trainingSide: args.moment.sideToMove,
        originalMoveUci: args.moment.originalMoveUci,
        submittedMoveUci: args.submittedMoveUci,
        bestMoveUci: args.revision.bestMoveUci,
        acceptedMovesUci: args.revision.acceptedMovesUci,
        acceptedMovesComplete:
            ['QUALITY_BOUNDARY_VERIFIED', 'ALL_LEGAL_ASSESSED'].includes(
                String((args.revision.answerCoverage as Record<string, unknown>)?.status)
            ),
        bestLineUci: Array.isArray(args.revision.bestLine)
            ? args.revision.bestLine.filter(
                  (move): move is string => typeof move === 'string'
              )
            : [],
        scoreAtStart: nullablePovScore(args.revision.scoreAtStart),
        originalDecision: {
            scoreBefore,
            scoreAfter,
            cpLoss: typeof original.cpLoss === 'number' ? original.cpLoss : null,
            winChanceLoss: typeof original.winChanceLoss === 'number' ? original.winChanceLoss : null,
        },
        comparison: args.comparison,
        sourceKinds: Array.isArray(original.sourceKinds) ? original.sourceKinds as TrainingSourceKind[] : [],
        lessonKinds: Array.isArray(original.lessonKinds) ? original.lessonKinds as TrainingLessonKind[] : [],
        themes: Array.isArray(original.themes) ? original.themes as string[] : [],
        source: {
            gameId: args.moment.gameId,
            provider: gameSourceToUi(args.moment.game.provider),
            playedAt: args.moment.game.playedAt.toISOString(),
            decisionPly: args.moment.decisionPly,
        },
    };
}
