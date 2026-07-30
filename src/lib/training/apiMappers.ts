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
    GradingPolicyV2,
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';

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
        provider: 'LICHESS' | 'CHESSCOM';
        playedAt: Date;
    };
    currentSolutionRevision: {
        bestMoveUci: string;
        acceptedMovesUci: string[];
        solutionShape: 'UNIQUE' | 'MULTIPLE' | 'OPEN';
        bestLine: unknown;
        scoreAtStart: unknown;
        gradingPolicy: unknown;
        solutionTree: unknown;
        moveAssessments: Array<{
            decisionIndex: number;
            fen: string;
            moveUci: string;
            source: 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE';
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
    const originalScoreAfter = nullablePovScore(row.scoreAfter);
    const gradingPolicy = gradingPolicyV2(
        row.currentSolutionRevision.gradingPolicy
    );
    if (!originalScoreAfter || !gradingPolicy) {
        throw new Error('Training prompt has invalid grading evidence');
    }
    const revision = row.currentSolutionRevision;
    const review = toTrainingReviewDto({
        moment: row,
        revision,
        submittedMoveUci: null,
        comparison: null,
    });
    const grading: TrainingGradingManifestDto = {
        version: 1,
        trainingSide: row.sideToMove,
        positionHistory: row.positionHistory,
        originalMoveUci: row.originalMoveUci,
        originalScoreAfter,
        gradingPolicy,
        solutionTree: trainingSolutionTreeDto(revision.solutionTree),
        moveAssessments: revision.moveAssessments
            .filter(
                (
                    assessment
                ): assessment is typeof assessment & {
                    status: 'VERIFIED';
                    grade: AttemptGrade;
                } =>
                    assessment.status === 'VERIFIED' &&
                    assessment.grade != null
            )
            .map(
                (assessment): TrainingMoveAssessmentDto => ({
                    decisionIndex: assessment.decisionIndex,
                    fen: assessment.fen,
                    moveUci: assessment.moveUci,
                    source: assessment.source,
                    grade: assessment.grade,
                    scoreAfter: nullablePovScore(
                        assessment.scoreAfter
                    ),
                    evidence: assessment.evidence,
                })
            ),
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

function gradingPolicyV2(value: unknown): GradingPolicyV2 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const policy = value as Partial<GradingPolicyV2>;
    return policy.version === 2 &&
        policy.pov === 'TRAINING_SIDE' &&
        policy.unknownMove === 'DYNAMIC' &&
        policy.matePolicy === 'EXACT' &&
        policy.tablebasePolicy === 'EXACT' &&
        !!policy.best &&
        !!policy.success &&
        !!policy.improvement
        ? (policy as GradingPolicyV2)
        : null;
}

function trainingSolutionTreeDto(
    value: unknown
): TrainingSolutionTreeNodeDto {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Training prompt has an invalid solution tree');
    }
    const node = value as Record<string, unknown>;
    if (
        typeof node.fen !== 'string' ||
        !Number.isSafeInteger(node.ply) ||
        (node.role !== 'USER' &&
            node.role !== 'OPPONENT' &&
            node.role !== 'TERMINAL') ||
        !Array.isArray(node.branches)
    ) {
        throw new Error('Training prompt has an invalid solution tree');
    }
    return {
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
                child: trainingSolutionTreeDto(branch.child),
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
            provider: 'LICHESS' | 'CHESSCOM';
            playedAt: Date;
        };
    };
    revision: {
        bestMoveUci: string;
        acceptedMovesUci: string[];
        solutionShape: 'UNIQUE' | 'MULTIPLE' | 'OPEN';
        bestLine: unknown;
        scoreAtStart: unknown;
    };
    submittedMoveUci: string | null;
    comparison: TrainingComparisonDto | null;
}): TrainingReviewDto {
    const scoreBefore = nullablePovScore(args.moment.scoreBefore);
    const scoreAfter = nullablePovScore(args.moment.scoreAfter);
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
        acceptedMovesComplete: args.revision.solutionShape !== 'OPEN',
        bestLineUci: Array.isArray(args.revision.bestLine)
            ? args.revision.bestLine.filter(
                  (move): move is string => typeof move === 'string'
              )
            : [],
        scoreAtStart: nullablePovScore(args.revision.scoreAtStart),
        originalDecision: {
            scoreBefore,
            scoreAfter,
            cpLoss: args.moment.cpLoss,
            winChanceLoss: args.moment.winChanceLoss,
        },
        comparison: args.comparison,
        sourceKinds: args.moment.sourceKinds,
        lessonKinds: args.moment.lessonKinds,
        themes: args.moment.themes,
        source: {
            gameId: args.moment.gameId,
            provider:
                args.moment.game.provider === 'LICHESS'
                    ? 'lichess'
                    : 'chesscom',
            playedAt: args.moment.game.playedAt.toISOString(),
            decisionPly: args.moment.decisionPly,
        },
    };
}
