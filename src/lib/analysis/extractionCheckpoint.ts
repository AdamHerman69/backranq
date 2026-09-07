import { PositionAnalysisPool } from './positionAnalysisPool';
import type { TrainingMomentExtractionCheckpoint } from './extractTrainingMoments';
import { MAX_ASSESSMENT_POSITION_HISTORY } from '@/lib/training/assessmentIdentity';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function evaluation(value: unknown): boolean {
    if (!isRecord(value) || typeof value.fen !== 'string' ||
        typeof value.bestMoveUci !== 'string' || !strings(value.pvUci)) return false;
    return value.score === null || (isRecord(value.score) &&
        (value.score.type === 'cp' || value.score.type === 'mate') && finite(value.score.value));
}

/** Reads the current extractor-owned checkpoint, including its reusable evidence. */
export function parseExtractionCheckpoint(value: unknown): TrainingMomentExtractionCheckpoint {
    if (!isRecord(value)) throw new Error('Analysis checkpoint is not an object');
    if (
        value.version !== 2 ||
        typeof value.gameId !== 'string' ||
        typeof value.sourceGameId !== 'string' ||
        typeof value.sourcePgnHash !== 'string' ||
        typeof value.configHash !== 'string' ||
        !finite(value.nextPly) || !Number.isInteger(value.nextPly) || value.nextPly < 0 ||
        !finite(value.expectedPlies) || !Number.isInteger(value.expectedPlies) || value.expectedPlies < value.nextPly ||
        !Array.isArray(value.reassessDecisionPlies) || !value.reassessDecisionPlies.every(ply =>
            Number.isInteger(ply) && ply >= 0 && ply < (value.expectedPlies as number)) ||
        new Set(value.reassessDecisionPlies).size !== value.reassessDecisionPlies.length ||
        !Array.isArray(value.moments) ||
        !Array.isArray(value.gameAnalysis) ||
        !Array.isArray(value.whiteMoveAccuracies) || !value.whiteMoveAccuracies.every(finite) ||
        !Array.isArray(value.blackMoveAccuracies) || !value.blackMoveAccuracies.every(finite) ||
        !strings(value.extractionErrors) ||
        !Array.isArray(value.decisionReceipts) || !value.decisionReceipts.every(item =>
            Array.isArray(item) && item.length === 2 && Number.isInteger(item[0]) &&
            item[0] >= 0 && isRecord(item[1]) && item[1].ply === item[0]) ||
        (value.pendingScan !== undefined && typeof value.pendingScan !== 'boolean') ||
        (value.pendingOpponentError !== undefined && typeof value.pendingOpponentError !== 'boolean') ||
        (value.scanEvidence !== undefined && (!Array.isArray(value.scanEvidence) ||
            value.scanEvidence.length > 2 || !value.scanEvidence.every(item =>
                isRecord(item) && typeof item.fen === 'string' && strings(item.previousFens) &&
                item.previousFens.length <= MAX_ASSESSMENT_POSITION_HISTORY &&
                evaluation(item.evaluation) && (item.evaluation as Record<string, unknown>).fen === item.fen))) ||
        (value.pendingConfirmation !== undefined && (!isRecord(value.pendingConfirmation) ||
            typeof value.pendingConfirmation.confirmed !== 'boolean' ||
            (value.pendingConfirmation.newEval != null && !evaluation(value.pendingConfirmation.newEval)) ||
            (value.pendingConfirmation.afterEval != null && !evaluation(value.pendingConfirmation.afterEval))))
    ) throw new Error('Analysis checkpoint has an invalid shape');
    if (!isRecord(value.analysisPool)) throw new Error('Analysis checkpoint is missing its evidence pool');
    PositionAnalysisPool.hydrate(value.analysisPool as unknown as Parameters<typeof PositionAnalysisPool.hydrate>[0]);
    return value as unknown as TrainingMomentExtractionCheckpoint;
}
