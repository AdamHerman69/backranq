import type { TrainingMomentCandidate } from '@/lib/training/contracts';
import type {
    TrainingPromptDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import type { NormalizedGame } from '@/lib/types/game';

import type { LandingPuzzleDto } from './contracts';

function solutionTreeDto(value: unknown): TrainingSolutionTreeNodeDto {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Verified puzzle has no usable solution tree.');
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
        throw new Error('Verified puzzle has an invalid solution tree.');
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
            ? { alternativesComplete: node.alternativesComplete }
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
                throw new Error('Verified puzzle has an invalid solution branch.');
            }
            const branch = rawBranch as Record<string, unknown>;
            if (
                typeof branch.moveUci !== 'string' ||
                typeof branch.best !== 'boolean'
            ) {
                throw new Error('Verified puzzle has an invalid solution branch.');
            }
            return {
                moveUci: branch.moveUci,
                best: branch.best,
                child: solutionTreeDto(branch.child),
            };
        }),
    };
}

export function trainingPromptFromCandidate(
    candidate: TrainingMomentCandidate
): TrainingPromptDto {
    if (
        !candidate.solution.trainable ||
        candidate.solution.verificationStatus !== 'VERIFIED' ||
        candidate.solution.acceptanceFrontier.status !== 'STABLE'
    ) {
        throw new Error(
            'Only a verified candidate with a stable accepted set can become a public puzzle.'
        );
    }
    return {
        id: `public:${candidate.sourcePgnHash}:${candidate.decisionPly}`,
        solutionRevisionId: candidate.solution.solutionHash,
        fen: candidate.fen,
        sideToMove: candidate.sideToMove,
        grading: {
            version: 1,
            trainingSide: candidate.sideToMove,
            positionHistory: candidate.positionHistory,
            originalMoveUci: candidate.originalMoveUci,
            originalScoreAfter: candidate.originalDecision.scoreAfter,
            gradingPolicy: candidate.solution.gradingPolicy,
            acceptanceFrontier:
                candidate.solution.acceptanceFrontier,
            solutionTree: solutionTreeDto(candidate.solution.solutionTree),
            moveAssessments: candidate.solution.moveAssessments.map(
                (assessment) => ({
                    decisionIndex: assessment.decisionIndex,
                    fen: assessment.fen,
                    moveUci: assessment.moveUci,
                    source: assessment.source,
                    grade: assessment.grade,
                    scoreAfter: assessment.scoreAfter,
                    evidence: assessment.evidence,
                })
            ),
            review: {
                trainingSide: candidate.sideToMove,
                originalMoveUci: candidate.originalMoveUci,
                submittedMoveUci: null,
                bestMoveUci: candidate.solution.bestMoveUci,
                acceptedMovesUci: candidate.solution.acceptedMovesUci,
                acceptedMovesComplete:
                    candidate.solution.acceptanceFrontier.status ===
                    'STABLE',
                bestLineUci: candidate.solution.bestLineUci,
                scoreAtStart: candidate.solution.scoreAtStart,
                originalDecision: {
                    scoreBefore: candidate.originalDecision.scoreBefore,
                    scoreAfter: candidate.originalDecision.scoreAfter,
                    cpLoss: candidate.originalDecision.cpLoss ?? null,
                    winChanceLoss:
                        candidate.originalDecision.winChanceLoss ?? null,
                },
                comparison: null,
                sourceKinds: candidate.sourceKinds,
                lessonKinds: candidate.lessonKinds,
                themes: candidate.themes,
                source: {
                    gameId: candidate.sourceGameId,
                    provider: candidate.sourceProvider,
                    playedAt: candidate.sourcePlayedAt,
                    decisionPly: candidate.decisionPly,
                },
            },
        },
    };
}

export function landingPuzzleFromCandidate(args: {
    candidate: TrainingMomentCandidate;
    game: NormalizedGame;
}): LandingPuzzleDto {
    return {
        id: `personal:${args.candidate.sourcePgnHash}:${args.candidate.decisionPly}`,
        prompt: trainingPromptFromCandidate(args.candidate),
        context: {
            kind: 'PERSONAL',
            headline: 'A position you actually played',
            teaser: 'Find the move you will want to remember next time.',
            sourceUrl: args.game.url ?? null,
            playedAt: args.game.playedAt,
            whiteName: args.game.white.name,
            blackName: args.game.black.name,
        },
    };
}
