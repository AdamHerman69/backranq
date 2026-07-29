import type {
    TrainingComparisonDto,
    TrainingPromptDto,
    TrainingReviewDto,
} from '@/lib/training/api';
import type {
    PovScore,
    TrainingLessonKind,
    TrainingSourceKind,
} from '@/lib/training/contracts';

export function toTrainingPromptDto(row: {
    id: string;
    currentSolutionRevisionId: string | null;
    fen: string;
    sideToMove: string;
}): TrainingPromptDto {
    if (
        !row.currentSolutionRevisionId ||
        (row.sideToMove !== 'w' && row.sideToMove !== 'b')
    ) {
        throw new Error('Training prompt is missing canonical state');
    }
    return {
        id: row.id,
        solutionRevisionId: row.currentSolutionRevisionId,
        fen: row.fen,
        sideToMove: row.sideToMove,
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
