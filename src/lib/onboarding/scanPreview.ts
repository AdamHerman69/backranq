import type { TrainingMomentExtractionProgress } from '@/lib/analysis/extractTrainingMoments';
import type { NormalizedGame } from '@/lib/types/game';
import type { OnboardingScanPreview } from './contracts';

/** Presentation uses the exact canonical position emitted by extraction. */
export function createScanPreview(
    game: NormalizedGame,
    progress: TrainingMomentExtractionProgress
): OnboardingScanPreview | undefined {
    if (progress.gameId !== game.id) return undefined;
    return {
        gameId: progress.gameId,
        fen: progress.fen,
        previousFen: progress.previousFen,
        orientation: progress.userSide,
        whiteName: game.white.name,
        blackName: game.black.name,
        playedAt: game.playedAt,
    };
}
