import {
    extractTrainingMomentsFromGames,
    isLandingReadyTrainingMoment,
} from '@/lib/analysis/extractTrainingMoments';
import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import type { NormalizedGame } from '@/lib/types/game';

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
    const games = args.games
        .slice()
        .sort(
            (left, right) =>
                new Date(right.playedAt).getTime() -
                new Date(left.playedAt).getTime()
        );
    const tablebase = new LichessTablebaseClient();
    const extractor = args.extractor ?? extractTrainingMomentsFromGames;

    for (const [gameIndex, game] of games.entries()) {
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const output = await extractor({
            games: [game],
            selectedGameIds: new Set([game.id]),
            engine: args.engine,
            tablebase,
            usernameByProvider: {
                [args.identity.provider]: args.identity.username,
            },
            signal: args.signal,
            stopAfterFirstVerified: true,
            onProgress: (progress) => {
                args.onProgress?.({
                    phase:
                        progress.phase === 'confirming'
                            ? 'CONFIRMING'
                            : 'SCANNING',
                    gameIndex,
                    gameCount: games.length,
                    ply: progress.ply,
                    plyCount: progress.plyCount,
                });
            },
            options: {
                returnAnalysis: false,
                nodesPerPosition: 12_000,
                confirmNodes: 180_000,
                maxConfirmationNodes: 500_000,
                verificationNodesPerPosition: 80_000,
            },
        });
        const candidate = output.moments.find(isLandingReadyTrainingMoment);
        if (candidate) return landingPuzzleFromCandidate({ candidate, game });
    }
    return null;
}
