import type { TrainingComparisonDto, TrainingReviewDto } from './api';
import type { PovScore, TrainingLessonKind, TrainingSourceKind } from './contracts';
import type { ComparisonFrame, EvidenceStore, MoveAssessment, PracticeMomentRevision, PracticeScore, Side } from './practiceContract';
import type { GameSource } from '@/lib/types/game';
import { expectedScore, normalizeScore, orderedObservations } from './assessmentPolicy';
import { CORROBORATED_SELECTION_POLICY_ID } from './selectionPolicy';

/** Project a comparison from its cited full-root line. A newer focused probe
 * can support the chosen move without replacing the baseline used by lossCp.
 * Inputs are already canonically validated; this never regrades a move. */
export function referenceProjectionForPracticeComparison(args: {
    assessment: MoveAssessment | undefined | null;
    reference: MoveAssessment | undefined | null;
    frame: ComparisonFrame | undefined;
    evidence: EvidenceStore;
    legalMovesUci: readonly string[];
    trainingSide: Side;
    referenceMoveUci: string;
}): { score: PracticeScore | null; pvUci: string[] | null } {
    const { assessment, reference, frame, evidence, trainingSide, referenceMoveUci } = args;
    if (reference?.score?.kind === 'EXACT') return { score: reference.score, pvUci: null };
    if (frame?.status === 'CURRENT' && assessment?.frameId === frame.id) {
        const cited = new Set(assessment.observationIds);
        const legal = new Set(args.legalMovesUci);
        const observation = orderedObservations(evidence).findLast(candidate => {
            const search = evidence.searches[candidate.searchId];
            return cited.has(candidate.id) && candidate.contextId === frame.contextId
                && candidate.engineFingerprint === frame.engineFingerprint && candidate.bundleComplete
                && candidate.lines.every(line => line.bound === 'UNBOUNDED')
                && search?.contextId === frame.contextId && search.engineIdentity.fingerprint === frame.engineFingerprint
                && search.request.trainingSide === trainingSide
                && candidate.rootScopeUci.length === legal.size && candidate.rootScopeUci.every(move => legal.has(move))
                && candidate.lines.some(line => line.moveUci === referenceMoveUci);
        });
        const line = observation?.lines.find(candidate => candidate.moveUci === referenceMoveUci);
        if (line) return { score: line.score, pvUci: [...line.pvUci] };
    }
    // Symbolic display does not invent a numeric comparison baseline.
    return { score: reference?.score?.kind === 'MATE' ? reference.score : null, pvUci: null };
}

export function referenceScoreForPracticeManifest(manifest: PracticeMomentRevision): PracticeScore | null {
    if (manifest.selection.comparison) return manifest.selection.comparison.referenceScore;
    if (manifest.selection.policyId !== CORROBORATED_SELECTION_POLICY_ID) return null;
    return referenceProjectionForPracticeComparison({
        assessment: manifest.assessments.find(assessment => assessment.id === manifest.decision.originalAssessmentId),
        reference: manifest.assessments.find(assessment => assessment.id === manifest.decision.referenceAssessmentId),
        frame: manifest.frames.find(candidate => candidate.id === manifest.rootAnswerIndex.frameId),
        evidence: manifest.evidence, legalMovesUci: manifest.rootAnswerIndex.legalMovesUci,
        trainingSide: manifest.source.trainingSide, referenceMoveUci: manifest.rootAnswerIndex.preferredMoveUci,
    }).score;
}

/** Selection display keeps its own declared comparison even while answer grades are pending. */
export function originalComparisonForPracticeManifest(manifest: PracticeMomentRevision) {
    const comparison = manifest.selection.comparison;
    if (comparison) {
        const side = manifest.source.trainingSide;
        const before = normalizeScore(comparison.referenceScore, side);
        const after = normalizeScore(comparison.originalScore, side);
        const referenceE = comparison.referenceWdl ? expectedScore(comparison.referenceWdl) : null;
        const originalE = comparison.originalWdl ? expectedScore(comparison.originalWdl) : null;
        return { referenceScore: comparison.referenceScore, originalScore: comparison.originalScore,
            metrics: { lossCp: before.kind === 'CP' && after.kind === 'CP' ? before.cp - after.cp : null,
                lossExpectedScore: referenceE === null || originalE === null ? null
                    : (comparison.referenceScore.pov === side ? referenceE : 1 - referenceE)
                        - (comparison.originalScore.pov === side ? originalE : 1 - originalE) } };
    }
    if (manifest.selection.policyId !== CORROBORATED_SELECTION_POLICY_ID) throw new Error('Selection comparison is missing');
    const original = manifest.assessments.find(a => a.id === manifest.decision.originalAssessmentId);
    return { referenceScore: referenceScoreForPracticeManifest(manifest), originalScore: original?.score ?? null,
        metrics: { lossCp: original?.metrics.lossCp ?? null, lossExpectedScore: original?.metrics.lossExpectedScore ?? null } };
}

/** Presentation-only conversion. Grading always consumes canonical v5 evidence. */
export function practiceScoreToWhitePov(score: PracticeScore | null): PovScore | null {
    if (!score) return null;
    if (score.kind === 'CP') return { kind: 'cp', pov: 'WHITE', cp: score.pov === 'WHITE' ? score.cp : -score.cp };
    if (score.kind === 'MATE') return { kind: 'mate', winner: score.winner, plies: score.plies };
    const wdl = score.pov === 'WHITE' || score.outcome === 'DRAW' ? score.outcome : score.outcome === 'WIN' ? 'LOSS' : 'WIN';
    return { kind: 'tablebase', pov: 'WHITE', wdl, ...(score.distance === null ? {} : { dtz: score.distance }) };
}

export function reviewForPracticeManifest(args: {
    manifest: PracticeMomentRevision; provider: GameSource; playedAt: string;
    sourceKinds: TrainingSourceKind[]; lessonKinds: TrainingLessonKind[]; themes: string[];
    submittedMoveUci?: string | null; comparison?: TrainingComparisonDto | null;
}): TrainingReviewDto {
    const manifest = args.manifest;
    const original = originalComparisonForPracticeManifest(manifest);
    const before = practiceScoreToWhitePov(original.referenceScore);
    const after = practiceScoreToWhitePov(original.originalScore);
    if (!before || !after) throw new Error('Practice revision has no original comparison scores');
    return {
        trainingSide: manifest.source.trainingSide === 'WHITE' ? 'w' : 'b',
        originalMoveUci: manifest.source.originalMoveUci, submittedMoveUci: args.submittedMoveUci ?? null,
        bestMoveUci: manifest.rootAnswerIndex.preferredMoveUci,
        acceptedMovesUci: manifest.assessments.filter(a => manifest.rootAnswerIndex.assessmentIds.includes(a.id)
            && a.quality === 'GOOD' && a.qualitySupport === 'SUPPORTED').map(a => a.moveUci),
        acceptedMovesComplete: manifest.rootAnswerIndex.readiness === 'ALL_MOVES_CLASSIFIED',
        bestLineUci: manifest.continuation.explanationLines.find(line => line.startContextId === manifest.source.contextId)?.movesUci
            ?? [manifest.rootAnswerIndex.preferredMoveUci],
        scoreAtStart: before,
        originalDecision: { scoreBefore: before, scoreAfter: after,
            cpLoss: original?.metrics.lossCp ?? null, winChanceLoss: original?.metrics.lossExpectedScore ?? null },
        comparison: args.comparison ?? null, sourceKinds: args.sourceKinds, lessonKinds: args.lessonKinds, themes: args.themes,
        source: { gameId: manifest.source.gameId, provider: args.provider, playedAt: args.playedAt,
            decisionPly: manifest.source.decisionPly },
    };
}
