import { fixtureSolution } from '../helpers/extractionEvidence';
// Regression for the audited immutable-source versus mutable-score defect.
import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    type SolutionRevisionInput,
} from '@/lib/training/contracts';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    persistTrainingMomentsInTransaction,
    type PersistableTrainingMoment,
} from '@/lib/training/persistence';
import { assessmentPositionKey } from '@/lib/training/assessmentIdentity';

const sourcePgn = '[White "Audit player"]\n[Black "Opponent"]\n\n1. d4 *';
const sourcePgnHash = hashSourcePgn(sourcePgn);
const rootFen = new Chess().fen();
function fenAfter(moveUci: string) {
    const board = new Chess(rootFen);
    board.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4) });
    return board.fen();
}
const rootAssessmentKey = assessmentPositionKey(rootFen, []);

function solution(bestMoveUci = 'e2e4'): SolutionRevisionInput {
    const semantics = fixtureSolution({
        verificationStatus: 'VERIFIED' as const,
        solutionShape: 'UNIQUE' as const,
        gradingStrategy: 'PRECOMPUTED' as const,
        continuationShape: 'SINGLE_DECISION' as const,
        trainable: true,
        bestMoveUci,
        acceptedMovesUci: [bestMoveUci],
        acceptanceFrontier: {
            version: 1 as const,
            status: 'STABLE' as const,
            targetCutoffCp: 100,
            effectiveCutoffCp: 70,
            boundaryGapCp: 40,
            moves: [
                {
                    moveUci: bestMoveUci,
                    tier: 'BEST' as const,
                },
            ],
            firstRejectedMoveUci: null,
        },
        moveAssessments: [
            {
                positionKey: rootAssessmentKey,
                decisionIndex: 0,
                fen: rootFen,
                moveUci: bestMoveUci,
                source: 'PRECOMPUTED' as const,
                grade: 'BEST' as const,
                scoreAfter: {
                    kind: 'cp' as const,
                    cp: 82,
                    pov: 'WHITE' as const,
                },
                evidence: { depth: 22 },
            },
        ],
        bestLineUci: [bestMoveUci],
        solutionTree: {
            fen: rootFen, ply: 0, role: 'USER', alternativesComplete: true,
            acceptedMovesUci: [bestMoveUci],
            branches: [{ moveUci: bestMoveUci, best: true, child: {
                fen: fenAfter(bestMoveUci), ply: 1, role: 'TERMINAL',
                acceptedMovesUci: [], branches: [],
            } }],
        },
        scoreAtStart: { kind: 'cp' as const, cp: 80, pov: 'WHITE' as const },
        playedMoveScore: {
            kind: 'cp' as const,
            cp: -40,
            pov: 'WHITE' as const,
        },
        targetOutcome: { preserve: 'advantage' },
        gradingPolicy: normalizeGradingPolicy(undefined),
    });
    return {
        ...semantics,
        solutionHash: solutionSemanticsHash(semantics),
        evidence: { depth: 22 },
        generatorVersion: 'test-v2',
        configHash: 'config-1',
    };
}

function moment(
    overrides: Partial<PersistableTrainingMoment> = {}
): PersistableTrainingMoment {
    return {
        decisionPly: 0,
        fen: rootFen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'd2d4',
        originalDecision: {
            scoreBefore: { kind: 'cp', cp: 80, pov: 'WHITE' },
            scoreAfter: { kind: 'cp', cp: -40, pov: 'WHITE' },
            cpLoss: 120,
            winChanceLoss: 0.31,
        },
        confidence: 0.94,
        phase: 'OPENING',
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['AVOID_MISTAKE'],
        themes: ['quietmove'],
        solution: solution(),
        ...overrides,
    };
}

function existingMoment(
    currentSolutionRevisionId: string | null = 'revision-current'
) {
    return {
        id: 'moment-1',
        momentKey: 'stored-key',
        sourcePgnHash: sourcePgnHash,
        decisionPly: 0,
        fen: moment().fen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'd2d4',
        scoreBefore: moment().originalDecision.scoreBefore,
        scoreAfter: moment().originalDecision.scoreAfter,
        cpLoss: 120,
        winChanceLoss: 0.31,
        confidence: 0.94,
        phase: 'OPENING',
        currentSolutionRevisionId,
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['AVOID_MISTAKE'],
        themes: ['quietmove'],
    };
}

function transaction() {
    const tx = {
        analysisRun: {
            findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }),
        },
        trainingMoment: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({ id: 'moment-1' }),
            update: vi.fn().mockResolvedValue({ id: 'moment-1' }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        solutionRevision: {
            findUnique: vi.fn(),
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockImplementation(({ data }) =>
                Promise.resolve({
                    id: 'revision-new',
                    momentId: data.momentId,
                    solutionHash: data.solutionHash,
                })
            ),
        },
        solutionMoveAssessment: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        trainingMomentObservation: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({
                momentId: 'moment-1',
                analysisRunId: 'run-1',
            }),
        },
    };
    return tx;
}

function persist(
    tx: ReturnType<typeof transaction>,
    moments: PersistableTrainingMoment[],
    analysisRunId = 'run-1',
    manifestOverrides: Partial<import('@/lib/analysis/extractTrainingMoments').ExtractionCompletionManifest> = {}
) {
    return persistTrainingMomentsInTransaction({
        tx: tx as never,
        userId: 'user-1',
        gameId: 'game-1',
        sourcePgnHash: sourcePgnHash,
        analysisRunId,
        analysisConfigHash: 'config-1',
        extractionManifest: {
            scope: 'FULL_GAME',
            scanComplete: true,
            extractionComplete: true,
            decisionOutcomes: [],
            version: 1,
            complete: true,
            sourceGameId: 'game-1',
            sourcePgnHash: sourcePgnHash,
            scannedPlies: 1,
            expectedPlies: 1,
            termination: 'COMPLETED',
            errors: [],
            ...manifestOverrides,
        },
        moments,
    });
}


describe('standard-analysis audit: mutable evidence versus stable identity', () => {
    it('appends a new revision when a scan score changes by 1 cp', async () => {
        const source = new Chess();
        source.loadPgn(sourcePgn, { strict: false });
        expect(source.history({ verbose: true })[0]?.before).toBe(rootFen);
        expect(source.history({ verbose: true })[0]?.lan).toBe('d2d4');
        expect(fenAfter('e2e4')).not.toBe(rootFen);
        const tx = transaction();
        tx.trainingMoment.findUnique.mockResolvedValue(existingMoment() as never);
        tx.solutionRevision.findUnique.mockResolvedValue({ id: 'revision-current', momentId: 'moment-1', solutionHash: solution().solutionHash });
        const rescanned = moment();
        rescanned.originalDecision.scoreBefore = { kind: 'cp', cp: 81, pov: 'WHITE' };
        rescanned.originalDecision.cpLoss = 121;
        rescanned.solution.scoreAtStart = { kind: 'cp', cp: 81, pov: 'WHITE' };
        rescanned.solution.solutionHash = solutionSemanticsHash(rescanned.solution);
        await expect(persist(tx, [rescanned], 'run-2')).resolves.toMatchObject({upserted: 1});
        expect(tx.solutionRevision.create).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({
            originalDecision: expect.objectContaining({ scoreBefore: {kind:'cp',cp:81,pov:'WHITE'}, cpLoss:121 }),
        })}));
        expect(tx.trainingMoment.upsert).toHaveBeenCalledOnce();
    });
    it('rejects changed original evidence on a same-run retry even when semantics match', async () => {
        const tx = transaction();
        const candidate = moment();
        tx.trainingMoment.findUnique.mockResolvedValue(existingMoment() as never);
        tx.solutionRevision.findUnique.mockResolvedValue({ id: 'revision-current', momentId: 'moment-1', solutionHash: candidate.solution.solutionHash });
        tx.trainingMomentObservation.findUnique.mockResolvedValue({
            solutionRevisionId: 'revision-current', observedSolutionHash: candidate.solution.solutionHash,
            solutionRevision: { configHash: candidate.solution.configHash, generatorVersion: candidate.solution.generatorVersion,
                originalDecision: { ...candidate.originalDecision, cpLoss: 119 }, evidence: {selected:candidate.solution.evidence} },
        } as never);
        await expect(persist(tx, [candidate])).rejects.toThrow('different immutable evidence');
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('retains a confirmed revision when a same-config reanalysis is unresolved', async () => {
        const tx = transaction();
        const candidate = moment();
        tx.trainingMoment.findUnique.mockResolvedValue(existingMoment() as never);
        tx.solutionRevision.findUnique.mockResolvedValue({ id: 'revision-current', momentId: 'moment-1',
            solutionHash: candidate.solution.solutionHash, configHash: 'config-1', trainable: true, verificationStatus: 'VERIFIED' });
        candidate.solution.decision = { status: 'UNRESOLVED', reason: 'BUDGET_EXHAUSTED' };
        candidate.solution.trainable = false;
        candidate.solution.solutionHash = solutionSemanticsHash(candidate.solution);
        await persist(tx, [candidate], 'run-2');
        expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(expect.objectContaining({update: {status:'ACTIVE', archivedAt:null}}));
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).toHaveBeenCalledOnce();
        expect(tx.trainingMomentObservation.create).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({solutionRevisionId:'revision-new'})}));
    });

});
