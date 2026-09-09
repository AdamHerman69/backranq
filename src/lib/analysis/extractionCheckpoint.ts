import { T2_BUDGETS } from './t2Policy';
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

function t2State(value: unknown, expectedPlies: number): boolean {
    if (!isRecord(value) || value.version !== 1 || !['SCAN', 'VERIFY', 'COMPLETE'].includes(String(value.phase))
        || !Number.isInteger(value.nextScanIndex) || Number(value.nextScanIndex) < 0 || Number(value.nextScanIndex) > expectedPlies + 1
        || !Number.isInteger(value.nextCandidateIndex) || Number(value.nextCandidateIndex) < 0
        || !finite(value.postSpent) || value.postSpent < 0 || value.postSpent > T2_BUDGETS.gameNodes
        || value.postSpent % T2_BUDGETS.confirmationNodes !== 0
        || !Array.isArray(value.scanSearchIds) || !value.scanSearchIds.every(pair => Array.isArray(pair) && pair.length === 2
            && Number.isInteger(pair[0]) && pair[0] >= 0 && pair[0] <= expectedPlies && typeof pair[1] === 'string')
        || new Set(value.scanSearchIds.map(pair => pair[0])).size !== value.scanSearchIds.length
        || !Array.isArray(value.candidatePlies) || !value.candidatePlies.every(ply => Number.isInteger(ply) && ply >= 0 && ply < expectedPlies)
        || new Set(value.candidatePlies).size !== value.candidatePlies.length
        || Number(value.nextCandidateIndex) > value.candidatePlies.length
        || !Array.isArray(value.decisions) || !value.decisions.every(d => isRecord(d) && Number.isInteger(d.ply)
            && Number(d.ply) >= 0 && Number(d.ply) < expectedPlies && typeof d.originalMoveUci === 'string'
            && (d.preferredMoveUci === null || typeof d.preferredMoveUci === 'string')
            && typeof d.candidate === 'boolean' && typeof d.admitted === 'boolean' && typeof d.reason === 'string'
            && ['GOOD', 'BELOW_STANDARD', 'UNKNOWN'].includes(String(d.estimate))
            && (d.lossCp === null || finite(d.lossCp)) && (d.lossExpectedScore === null || finite(d.lossExpectedScore))
            && ['SAME_ROOT', 'PARENT_CHILD_SCAN'].includes(String(d.comparisonBasis)) && strings(d.evidenceIds))) return false;
    if (value.phase === 'SCAN') return value.decisions.length === 0 && value.candidatePlies.length === 0 && value.nextCandidateIndex === 0 && value.postSpent === 0;
    return value.decisions.length === value.candidatePlies.length
        && value.decisions.every(d => (value.candidatePlies as number[]).includes(d.ply))
        && new Set(value.decisions.map(d => d.ply)).size === value.decisions.length
        && (value.phase !== 'COMPLETE' || value.nextCandidateIndex === value.candidatePlies.length);
}

/** Reads the current extractor-owned checkpoint, including its reusable evidence. */
export function parseExtractionCheckpoint(value: unknown): TrainingMomentExtractionCheckpoint {
    if (!isRecord(value)) throw new Error('Analysis checkpoint is not an object');
    if (
        value.version !== 2 ||
        (value.t2State !== undefined && !t2State(value.t2State, Number(value.expectedPlies))) ||
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
    const pool = PositionAnalysisPool.hydrate(value.analysisPool as unknown as Parameters<typeof PositionAnalysisPool.hydrate>[0], { maxContexts: 4096, maxSearches: 8192 });
    if (isRecord(value.t2State)) {
        const ids = new Set(pool.serialize().searches.map(search => search.evidence.id));
        if ((value.t2State.scanSearchIds as Array<[number, string]>).some(([, id]) => !ids.has(id))) throw new Error('T2 checkpoint is missing scan evidence');
    }
    return value as unknown as TrainingMomentExtractionCheckpoint;
}
