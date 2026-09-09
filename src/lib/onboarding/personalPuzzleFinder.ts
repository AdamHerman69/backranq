import {
    extractTrainingMomentsFromGames,
    isLandingReadyTrainingMoment,
} from '@/lib/analysis/extractTrainingMoments';
import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import { T2_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import type { NormalizedGame } from '@/lib/types/game';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';

import { createScanPreview } from './scanPreview';
import { landingPuzzleFromCandidate } from './candidatePrompt';
import type {
    LandingPuzzleDto,
    OnboardingAnalysisProgress,
    PublicChessIdentity,
} from './contracts';

export async function findFirstVerifiedPersonalPuzzle(args: {
    games: NormalizedGame[];
    identity: PublicChessIdentity;
    engine: StockfishEngine;
    signal?: AbortSignal;
    onProgress?: (progress: OnboardingAnalysisProgress) => void;
    extractor?: typeof extractTrainingMomentsFromGames;
}): Promise<LandingPuzzleDto | null> {
    if (args.signal?.aborted) throw new Error('Analysis aborted');
    const games = args.games
        .filter((game) => {
            const provenance = resolveGameAnalysisProvenance(game);
            return (
                game.provider === args.identity.provider &&
                provenance?.sourceUsername.toLocaleLowerCase('en-US') ===
                    args.identity.username.trim().toLocaleLowerCase('en-US')
            );
        })
        .slice()
        .sort(
            (left, right) =>
                new Date(right.playedAt).getTime() -
                new Date(left.playedAt).getTime()
        );
    const extractor = args.extractor ?? extractTrainingMomentsFromGames;
    const options = {
        returnAnalysis: false,
        selectionPolicyId: T2_SELECTION_POLICY_ID,
    };

    for (const [gameIndex, game] of games.entries()) {
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const output = await extractor({
            games: [game],
            selectedGameIds: new Set([game.id]),
            engine: args.engine,
            signal: args.signal,
            strategy: 'FIRST_PUZZLE',
            onProgress: (progress) => {
                if (args.signal?.aborted) return;
                args.onProgress?.({
                    runId: progress.runId,
                    phase: progress.phase === 'confirming' ? 'CONFIRMING' : 'SCANNING',
                    gameIndex,
                    gameCount: games.length,
                    ply: progress.ply,
                    plyCount: progress.plyCount,
                    preview: createScanPreview(game, progress),
                });
            },
            options,
        });
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const candidate = output.moments.find(isLandingReadyTrainingMoment);
        if (candidate) return landingPuzzleFromCandidate({ candidate, game });
    }
    return null;
}
