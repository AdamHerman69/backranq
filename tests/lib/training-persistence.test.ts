import { describe, expect, it, vi } from 'vitest';
import {
    solutionSemanticsHash,
    type SolutionRevisionInput,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    persistTrainingMomentsInTransaction,
    type PersistableTrainingMoment,
} from '@/lib/training/persistence';
import { replaceTrainingMomentsInTransaction } from '@/lib/api/trainingMomentPersistence';
import { assessmentPositionKey } from '@/lib/training/assessmentIdentity';

const rootFen = '8/8/8/8/8/8/4K3/6k1 w - - 0 1';
const rootAssessmentKey = assessmentPositionKey(rootFen, []);

function solution(bestMoveUci = 'e2e4'): SolutionRevisionInput {
    const semantics = {
        verificationStatus: 'VERIFIED' as const,
        solutionShape: 'UNIQUE' as const,
        gradingStrategy: 'PRECOMPUTED' as const,
        continuationShape: 'SINGLE_DECISION' as const,
        trainable: true,
        bestMoveUci,
        acceptedMovesUci: [bestMoveUci],
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
        bestLineUci: [bestMoveUci, 'e7e5'],
        solutionTree: { move: bestMoveUci },
        scoreAtStart: { kind: 'cp' as const, cp: 80, pov: 'WHITE' as const },
        playedMoveScore: {
            kind: 'cp' as const,
            cp: -40,
            pov: 'WHITE' as const,
        },
        targetOutcome: { preserve: 'advantage' },
        gradingPolicy: normalizeGradingPolicy(undefined),
    };
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
        decisionPly: 12,
        fen: rootFen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'e2f2',
        originalDecision: {
            scoreBefore: { kind: 'cp', cp: 80, pov: 'WHITE' },
            scoreAfter: { kind: 'cp', cp: -40, pov: 'WHITE' },
            cpLoss: 120,
            winChanceLoss: 0.31,
        },
        confidence: 0.94,
        phase: 'ENDGAME',
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
        sourcePgnHash: 'pgn-hash',
        decisionPly: 12,
        fen: moment().fen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'e2f2',
        scoreBefore: moment().originalDecision.scoreBefore,
        scoreAfter: moment().originalDecision.scoreAfter,
        cpLoss: 120,
        winChanceLoss: 0.31,
        confidence: 0.94,
        phase: 'ENDGAME',
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
    manifestOverrides: Partial<{
        version: 1;
        complete: boolean;
        sourceGameId: string;
        sourcePgnHash: string;
        scannedPlies: number;
        expectedPlies: number;
        termination: 'COMPLETED' | 'SOURCE_REPLAY_STOPPED';
        errors: string[];
    }> = {}
) {
    return persistTrainingMomentsInTransaction({
        tx: tx as never,
        userId: 'user-1',
        gameId: 'game-1',
        sourcePgnHash: 'pgn-hash',
        analysisRunId,
        analysisConfigHash: 'config-1',
        extractionManifest: {
            version: 1,
            complete: true,
            sourceGameId: 'game-1',
            sourcePgnHash: 'pgn-hash',
            scannedPlies: 20,
            expectedPlies: 20,
            termination: 'COMPLETED',
            errors: [],
            ...manifestOverrides,
        },
        moments,
    });
}

describe('canonical training persistence', () => {
    it('merges avoid and missed-opportunity metadata into one stable moment', async () => {
        const tx = transaction();
        const result = await persist(tx, [
            moment(),
            moment({
                sourceKinds: ['MISSED_OPPORTUNITY'],
                lessonKinds: ['PUNISH_MISTAKE'],
                themes: ['QuietMove', 'defense'],
            }),
        ]);

        expect(result.upserted).toBe(1);
        expect(Object.values(result.momentIdsByKey)).toEqual(['moment-1']);
        expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    sourceKinds: [
                        'MY_MISTAKE',
                        'MISSED_OPPORTUNITY',
                    ],
                    lessonKinds: [
                        'AVOID_MISTAKE',
                        'PUNISH_MISTAKE',
                    ],
                    themes: ['defense', 'quietmove'],
                    scoreBefore: {
                        kind: 'cp',
                        cp: 80,
                        pov: 'WHITE',
                    },
                    cpLoss: 120,
                    confidence: 0.94,
                }),
            })
        );
        expect(tx.solutionRevision.create).toHaveBeenCalledTimes(1);
        expect(tx.solutionMoveAssessment.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    solutionRevisionId: 'revision-new',
                    positionKey: rootAssessmentKey,
                    moveUci: 'e2e4',
                    status: 'VERIFIED',
                    grade: 'BEST',
                }),
            ],
        });
    });

    it('rejects conflicting solution hashes for one canonical decision', async () => {
        const tx = transaction();

        await expect(
            persist(tx, [
                moment(),
                moment({ solution: solution('d2d4') }),
            ])
        ).rejects.toThrow(
            'Conflicting solution hashes share one training moment identity'
        );

        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('keeps repeated boards at different decisions and halfmove clocks distinct', async () => {
        const tx = transaction();
        const base = solution();
        const repeatedBoardSolution: SolutionRevisionInput = {
            ...base,
            moveAssessments: [
                base.moveAssessments[0]!,
                {
                    ...base.moveAssessments[0]!,
                    decisionIndex: 2,
                    fen: '8/8/8/8/8/8/4K3/6k1 w - - 4 3',
                    positionKey: assessmentPositionKey(
                        '8/8/8/8/8/8/4K3/6k1 w - - 4 3',
                        [rootFen]
                    ),
                },
            ],
            solutionHash: '',
        };
        repeatedBoardSolution.solutionHash =
            solutionSemanticsHash(repeatedBoardSolution);

        await persist(tx, [
            moment({ solution: repeatedBoardSolution }),
        ]);

        expect(
            tx.solutionMoveAssessment.createMany
        ).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({
                    decisionIndex: 0,
                    positionKey: rootAssessmentKey,
                }),
                expect.objectContaining({
                    decisionIndex: 2,
                    positionKey: assessmentPositionKey(
                        '8/8/8/8/8/8/4K3/6k1 w - - 4 3',
                        [rootFen]
                    ),
                }),
            ],
        });
    });

    it('reuses the current immutable revision when semantics are unchanged', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution().solutionHash,
        });

        const result = await persist(tx, [moment()], 'run-2');

        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
        expect(tx.solutionMoveAssessment.createMany).not.toHaveBeenCalled();
        expect(tx.trainingMomentObservation.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                momentId: 'moment-1',
                analysisRunId: 'run-2',
                solutionRevisionId: 'revision-current',
                observedSolutionHash: solution().solutionHash,
            }),
        });
        expect(Object.values(result.solutionRevisionIdsByKey)).toEqual([
            'revision-current',
        ]);
        expect(tx.trainingMoment.update).toHaveBeenCalledWith({
            where: { id: 'moment-1' },
            data: { currentSolutionRevisionId: 'revision-current' },
        });
    });

    it('appends and activates a revision only when solution semantics change', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution('d2d4').solutionHash,
        });
        tx.solutionRevision.findFirst.mockResolvedValue({ revision: 4 });

        await persist(tx, [moment()], 'run-2');

        expect(tx.solutionRevision.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    momentId: 'moment-1',
                    analysisRunId: 'run-2',
                    revision: 5,
                    solutionHash: solution().solutionHash,
                }),
            })
        );
        expect(tx.trainingMoment.update).toHaveBeenCalledWith({
            where: { id: 'moment-1' },
            data: { currentSolutionRevisionId: 'revision-new' },
        });
    });

    it('appends a revision when grading-relevant assessment WDL evidence changes', async () => {
        const tx = transaction();
        const previous = solution();
        const changed: SolutionRevisionInput = {
            ...previous,
            moveAssessments: previous.moveAssessments.map(
                (assessment, index) =>
                    index === 0
                        ? {
                              ...assessment,
                              evidence: {
                                  bestGapWinChance: 0.03,
                                  preservesOutcome: true,
                                  evaluation: {
                                      source: 'ENGINE',
                                      score: {
                                          type: 'cp',
                                          value: 82,
                                      },
                                      wdl: {
                                          win: 500,
                                          draw: 400,
                                          loss: 100,
                                      },
                                  },
                              },
                          }
                        : assessment
            ),
            solutionHash: '',
        };
        changed.solutionHash = solutionSemanticsHash(changed);
        expect(changed.solutionHash).not.toBe(
            previous.solutionHash
        );
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: previous.solutionHash,
        });
        tx.solutionRevision.findFirst.mockResolvedValue({
            revision: 4,
        });

        await persist(
            tx,
            [moment({ solution: changed })],
            'run-evidence'
        );

        expect(tx.solutionRevision.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    revision: 5,
                    solutionHash: changed.solutionHash,
                }),
            })
        );
        expect(tx.trainingMoment.update).toHaveBeenCalledWith({
            where: { id: 'moment-1' },
            data: {
                currentSolutionRevisionId: 'revision-new',
            },
        });
    });

    it('rejects conflicting results from the same analysis run', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution('d2d4').solutionHash,
        });
        tx.trainingMomentObservation.findUnique.mockResolvedValue({
            solutionRevisionId: 'revision-run',
            observedSolutionHash: solution('g1f3').solutionHash,
        });

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /different solution semantics/
        );
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
    });

    it('rejects a current revision linked to another moment', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            id: 'revision-current',
            momentId: 'other-moment',
            solutionHash: solution().solutionHash,
        });

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /does not belong/
        );
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('archives stale moments without deleting attempts or revisions', async () => {
        const tx = transaction();
        tx.trainingMoment.updateMany.mockResolvedValue({ count: 3 });

        const result = await persist(tx, []);

        expect(result).toMatchObject({ upserted: 0, staleArchived: 3 });
        expect(tx.trainingMoment.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                gameId: 'game-1',
                archivedAt: null,
            },
            data: {
                archivedAt: expect.any(Date),
                status: 'ARCHIVED',
            },
        });
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('requires a complete extraction manifest before any read or write', async () => {
        const tx = transaction();

        await expect(
            persist(tx, [], 'run-1', {
                complete: false,
                scannedPlies: 9,
                expectedPlies: 10,
                termination: 'SOURCE_REPLAY_STOPPED',
                errors: ['invalid PGN suffix'],
            })
        ).rejects.toThrow(/complete extraction manifest/i);

        expect(tx.analysisRun.findFirst).not.toHaveBeenCalled();
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('rejects analysis-run provenance mismatches before moment writes', async () => {
        const tx = transaction();
        tx.analysisRun.findFirst.mockResolvedValue(null);

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /provenance does not match/i
        );

        expect(tx.analysisRun.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'run-1',
                userId: 'user-1',
                gameId: 'game-1',
                inputPgnHash: 'pgn-hash',
                configHash: 'config-1',
                status: 'RUNNING',
            },
            select: { id: true },
        });
        expect(tx.trainingMoment.findUnique).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('rejects candidates from another game before any write', async () => {
        const tx = transaction();
        const candidate: TrainingMomentCandidate = {
            sourceGameId: 'other-game',
            sourceProvider: 'lichess',
            sourcePlayedAt: '2026-07-05T12:00:00.000Z',
            sourcePgnHash: 'pgn-hash',
            ...moment(),
            confidence: 0.94,
            phase: 'ENDGAME',
        };

        await expect(
            replaceTrainingMomentsInTransaction({
                tx: tx as never,
                userId: 'user-1',
                gameId: 'game-1',
                sourceProvider: 'lichess',
                sourcePlayedAt: new Date('2026-07-05T12:00:00.000Z'),
                sourcePgnHash: 'pgn-hash',
                analysisRunId: 'run-1',
                analysisConfigHash: 'config-1',
                extractionManifest: {
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: 'pgn-hash',
                    scannedPlies: 20,
                    expectedPlies: 20,
                    termination: 'COMPLETED',
                    errors: [],
                },
                moments: [candidate],
            })
        ).rejects.toThrow(/completed game/);
        expect(tx.trainingMoment.findUnique).not.toHaveBeenCalled();
    });
});
