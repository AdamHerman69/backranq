import type { TrainingMomentCandidate } from '@/lib/training/contracts';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import type { GameSource } from '@/lib/types/game';
import {
    persistTrainingMomentsInTransaction,
    type PersistTrainingMomentsResult,
    type TrainingMomentTransactionClient,
} from '@/lib/training/persistence';

export type ReplaceTrainingMomentsResult = PersistTrainingMomentsResult;

/**
 * Persists authoritative extraction output only. There is intentionally no
 * adapter from an alternate client shape: incomplete evidence must be rejected
 * at the extraction boundary, not stored as a canonical training moment.
 */
export async function replaceTrainingMomentsInTransaction(args: {
    tx: TrainingMomentTransactionClient;
    userId: string;
    gameId: string;
    sourceProvider: GameSource;
    sourcePlayedAt: Date;
    sourcePgnHash: string;
    analysisRunId: string;
    analysisConfigHash: string;
    extractionManifest: ExtractionCompletionManifest;
    moments: TrainingMomentCandidate[];
}): Promise<ReplaceTrainingMomentsResult> {
    for (const moment of args.moments) {
        if (moment.sourceGameId !== args.gameId) {
            throw new Error(
                'Training moment does not belong to the completed game'
            );
        }
        if (
            moment.sourceProvider !== args.sourceProvider ||
            !Number.isFinite(Date.parse(moment.sourcePlayedAt)) ||
            Date.parse(moment.sourcePlayedAt) !==
                args.sourcePlayedAt.getTime()
        ) {
            throw new Error(
                'Training moment source metadata does not match the completed game'
            );
        }
        if (moment.sourcePgnHash !== args.sourcePgnHash) {
            throw new Error(
                'Training moment does not belong to the analysis source PGN'
            );
        }
    }

    return persistTrainingMomentsInTransaction({
        tx: args.tx,
        userId: args.userId,
        gameId: args.gameId,
        sourcePgnHash: args.sourcePgnHash,
        analysisRunId: args.analysisRunId,
        analysisConfigHash: args.analysisConfigHash,
        extractionManifest: args.extractionManifest,
        moments: args.moments.map((moment) => ({
            decisionPly: moment.decisionPly,
            fen: moment.fen,
            positionHistory: moment.positionHistory,
            sideToMove: moment.sideToMove,
            originalMoveUci: moment.originalMoveUci,
            originalDecision: moment.originalDecision,
            confidence: moment.confidence ?? null,
            phase: moment.phase ?? null,
            sourceKinds: moment.sourceKinds,
            lessonKinds: moment.lessonKinds,
            themes: moment.themes,
            solution: moment.solution,
        })),
    });
}
