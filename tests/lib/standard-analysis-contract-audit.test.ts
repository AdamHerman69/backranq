// Regression for stable source identity versus evolving score evidence.
import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import { persistTrainingMomentsInTransaction, type PersistableTrainingMoment } from '@/lib/training/persistence';
import { practicePositionFixture } from '../helpers/practice-position';
const sourcePgn = '[White "Audit player"]\n[Black "Opponent"]\n\n1. d4 *';
const sourcePgnHash = hashSourcePgn(sourcePgn);
const rootFen = new Chess().fen();
function moment(score = 30, snapshotCount = 3): PersistableTrainingMoment {
    const manifest = practicePositionFixture({ fen: rootFen, originalMoveUci: 'd2d4', bestMoveUci: 'e2e4', gameId: 'game-1', sourcePgnHash, configHash: 'config-1', scores: { e2e4: score }, snapshotCount });
    return { decisionPly: 0, fen: rootFen, positionHistory: [], sideToMove: 'w', originalMoveUci: 'd2d4', originalDecision: originalDecisionForPracticeManifest(manifest), confidence: 0.94, phase: 'OPENING', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], themes: ['quietmove'], solution: { manifest, configHash: 'config-1' } };
}
function transaction() {
    const value = moment();
    const current = { id: 'revision-current', momentId: 'moment-1', solutionHash: value.solution.manifest.semanticHash, configHash: 'config-1', generatorVersion: value.solution.manifest.generatorVersion, manifest: value.solution.manifest, trainable: true };
    return {
        analysisRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1', configSnapshot: { extractor: { confirmNodes: 100_000, gradingPolicy: value.solution.manifest.policySnapshot } } }) },
        trainingMoment: { findUnique: vi.fn().mockResolvedValue({ id: 'moment-1', momentKey: 'stored', sourcePgnHash, decisionPly: 0, fen: rootFen, positionHistory: [], sideToMove: 'w', originalMoveUci: 'd2d4', ...value.originalDecision, currentSolutionRevisionId: current.id, sourceKinds: value.sourceKinds, lessonKinds: value.lessonKinds, themes: value.themes }), upsert: vi.fn().mockResolvedValue({ id: 'moment-1' }), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        solutionRevision: { findUnique: vi.fn().mockResolvedValue(current), findFirst: vi.fn().mockResolvedValue({ revision: 1 }), create: vi.fn().mockImplementation(({ data }) => ({ id: 'revision-new', momentId: data.momentId, solutionHash: data.solutionHash })) },
        trainingMomentObservation: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    };
}
const persist = (tx: ReturnType<typeof transaction>, candidate: PersistableTrainingMoment) => persistTrainingMomentsInTransaction({ tx: tx as never, userId: 'user-1', gameId: 'game-1', sourcePgnHash, analysisRunId: 'run-2', analysisConfigHash: 'config-1', extractionManifest: { scope: 'FULL_GAME', scanComplete: true, extractionComplete: true, decisionOutcomes: [], version: 1, complete: true, sourceGameId: 'game-1', sourcePgnHash, scannedPlies: 1, expectedPlies: 1, termination: 'COMPLETED', errors: [] }, moments: [candidate] });

describe('standard analysis immutable evidence audit', () => {
    it('appends a new revision when supported evaluation changes by 1 cp', async () => {
        const tx = transaction(); const rescanned = moment(31);
        await expect(persist(tx, rescanned)).resolves.toMatchObject({ upserted: 1 });
        expect(tx.solutionRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ manifest: expect.objectContaining({ assessments: expect.arrayContaining([expect.objectContaining({ moveUci: 'e2e4', score: { kind: 'CP', cp: 31, pov: 'WHITE' } })]) }) }) }));
        expect(tx.trainingMoment.upsert).toHaveBeenCalledOnce();
    });
    it('rejects changed physical evidence on the same-run retry even when semantics match', async () => {
        const tx = transaction(); const candidate = moment();
        const previous = structuredClone(candidate.solution.manifest); Object.values(previous.evidence.searches)[0].sessionId = 'different-physical-session';
        tx.trainingMomentObservation.findUnique.mockResolvedValue({ solutionRevisionId: 'revision-current', observedSolutionHash: candidate.solution.manifest.semanticHash, solutionRevision: { configHash: 'config-1', generatorVersion: candidate.solution.manifest.generatorVersion, manifest: previous } });
        await expect(persist(tx, candidate)).rejects.toThrow('different immutable evidence');
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });
    it('retains a confirmed revision when same-policy reanalysis lacks supported quality', async () => {
        const tx = transaction(); const candidate = moment(30, 1);
        expect(candidate.solution.manifest.decision.status).toBe('UNRESOLVED');
        await persist(tx, candidate);
        expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { status: 'ACTIVE', archivedAt: null } }));
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).toHaveBeenCalledOnce();
        expect(tx.trainingMomentObservation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ solutionRevisionId: 'revision-new' }) }));
    });
});
