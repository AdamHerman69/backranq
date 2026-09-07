import type { TrainingComparisonDto, TrainingPromptDto, TrainingReviewDto } from './api';
import type { PovScore, TrainingLessonKind, TrainingSourceKind } from './contracts';
import { stableCanonicalStringify } from './contracts';
import { parsePracticeMomentRevision } from './practiceContract';
import { reviewForPracticeManifest } from './practiceReview';
import { gameSourceToUi } from '@/lib/games/dbMappings';
import type { GameSource } from '@prisma/client';

type MomentRow = {
    id: string; gameId: string; decisionPly: number; sideToMove: string; originalMoveUci: string;
    sourceKinds: TrainingSourceKind[]; lessonKinds: TrainingLessonKind[]; themes: string[];
    game: { provider: GameSource; playedAt: Date };
};
export function toTrainingPromptDto(row: MomentRow & {
    currentSolutionRevisionId: string | null; fen: string; positionHistory: string[];
    currentSolutionRevision: { manifest: unknown; trainable: boolean } | null;
}): TrainingPromptDto {
    if (!row.currentSolutionRevisionId || !row.currentSolutionRevision?.trainable) throw new Error('Practice revision unavailable');
    const manifest = parsePracticeMomentRevision(row.currentSolutionRevision.manifest);
    if (manifest.momentId !== row.id || manifest.revisionId !== row.currentSolutionRevisionId
        || manifest.source.gameId !== row.gameId || manifest.source.decisionPly !== row.decisionPly
        || manifest.source.fen !== row.fen || manifest.source.originalMoveUci !== row.originalMoveUci
        || manifest.source.trainingSide !== (row.sideToMove === 'w' ? 'WHITE' : 'BLACK')
        || stableCanonicalStringify(manifest.source.positionHistory) !== stableCanonicalStringify(row.positionHistory)
        || manifest.decision.status !== 'CONFIRMED_MISTAKE' || manifest.decision.selection !== 'INCLUDED') {
        throw new Error('Practice manifest does not match the source decision');
    }
    return { id: row.id, solutionRevisionId: row.currentSolutionRevisionId, fen: row.fen,
        sideToMove: manifest.source.trainingSide === 'WHITE' ? 'w' : 'b', grading: manifest,
        review: toTrainingReviewDto({ moment: row, revision: { manifest }, submittedMoveUci: null, comparison: null }) };
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
    moment: MomentRow; revision: { manifest: unknown };
    submittedMoveUci: string | null; comparison: TrainingComparisonDto | null;
}): TrainingReviewDto {
    return reviewForPracticeManifest({ manifest: parsePracticeMomentRevision(args.revision.manifest),
        provider: gameSourceToUi(args.moment.game.provider), playedAt: args.moment.game.playedAt.toISOString(),
        sourceKinds: args.moment.sourceKinds, lessonKinds: args.moment.lessonKinds, themes: args.moment.themes,
        submittedMoveUci: args.submittedMoveUci, comparison: args.comparison });
}
