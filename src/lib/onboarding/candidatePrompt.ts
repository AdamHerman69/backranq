import { isTrainableSolution, type TrainingMomentCandidate } from '@/lib/training/contracts';
import type { TrainingPromptDto } from '@/lib/training/api';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { reviewForPracticeManifest } from '@/lib/training/practiceReview';
import type { NormalizedGame } from '@/lib/types/game';
import type { LandingPuzzleDto } from './contracts';

export function trainingPromptFromCandidate(candidate: TrainingMomentCandidate): TrainingPromptDto {
    if (!isTrainableSolution(candidate.solution)) throw new Error('Only a supported selected decision can become a puzzle');
    const id = `public:${candidate.sourcePgnHash}:${candidate.decisionPly}`;
    const manifest = parsePracticeMomentRevision({ ...candidate.solution.manifest,
        momentId: id, revisionId: candidate.solution.manifest.semanticHash });
    return { id, solutionRevisionId: manifest.revisionId, fen: candidate.fen, sideToMove: candidate.sideToMove,
        grading: manifest, review: reviewForPracticeManifest({ manifest, provider: candidate.sourceProvider,
            playedAt: candidate.sourcePlayedAt, sourceKinds: candidate.sourceKinds,
            lessonKinds: candidate.lessonKinds, themes: candidate.themes }) };
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
