import {
    extractTrainingMomentsFromGames,
    isLandingReadyTrainingMoment,
    type LandingDecisionCandidate,
} from '@/lib/analysis/extractTrainingMoments';
import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import type { NormalizedGame } from '@/lib/types/game';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';

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
    const tablebase = new LichessTablebaseClient();
    const extractor = args.extractor ?? extractTrainingMomentsFromGames;
    const candidates: Array<LandingDecisionCandidate & { gameIndex: number }> = [];
    const options = {
        returnAnalysis: false,
        nodesPerPosition: 12_000,
        confirmNodes: 180_000,
        maxConfirmationNodes: 500_000,
        verificationNodesPerPosition: 80_000,
    };

    for (const [gameIndex, game] of games.entries()) {
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const gameCandidates = new Map<number, LandingDecisionCandidate>();
        await extractor({
            games: [game],
            selectedGameIds: new Set([game.id]),
            engine: args.engine,
            tablebase,
            signal: args.signal,
            stopAfterFirstVerified: true,
            landingSearch: {
                mode: 'SCOUT',
                onCandidate: (candidate) => {
                    gameCandidates.set(candidate.decisionPly, candidate);
                },
            },
            onProgress: (progress) => {
                args.onProgress?.({
                    phase: 'SCANNING',
                    gameIndex,
                    gameCount: games.length,
                    ply: progress.ply,
                    plyCount: progress.plyCount,
                });
            },
            options,
        });
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        candidates.push(
            ...Array.from(gameCandidates.values(), (candidate) => ({
                ...candidate,
                gameIndex,
            }))
        );
    }

    candidates.sort(
        (left, right) =>
            (right.loss.winningChance ?? 0) -
                (left.loss.winningChance ?? 0) ||
            (right.loss.cp ?? 0) - (left.loss.cp ?? 0) ||
            left.gameIndex - right.gameIndex ||
            left.decisionPly - right.decisionPly
    );
    for (const { gameIndex, decisionPly } of candidates) {
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const game = games[gameIndex]!;
        const output = await extractor({
            games: [game],
            selectedGameIds: new Set([game.id]),
            engine: args.engine,
            tablebase,
            signal: args.signal,
            stopAfterFirstVerified: true,
            landingSearch: { mode: 'VERIFY', decisionPly },
            onProgress: (progress) => {
                args.onProgress?.({
                    phase: 'CONFIRMING',
                    gameIndex,
                    gameCount: games.length,
                    ply: decisionPly,
                    plyCount: progress.plyCount,
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
