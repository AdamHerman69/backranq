import type { GameAnalysis } from '@/lib/analysis/classification';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS,
    hashAnalysisConfig,
} from '@/lib/services/analysisRuns';
import {
    solutionSemanticsHash,
    type SolutionRevisionInput,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import { assessmentPositionKey } from '@/lib/training/assessmentIdentity';
import { analysisDefaultsToExtractOptions } from '@/lib/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type AnalysisRouteModule = typeof import('@/app/api/games/[id]/analysis/route');
type PrismaMockWithTransaction = typeof prismaMock & {
    $transaction: ReturnType<typeof vi.fn>;
};

const ownedGame = {
    id: 'game-1',
    provider: 'LICHESS',
    externalId: 'source-game-1',
    playedAt: new Date('2026-07-04T12:00:00.000Z'),
    pgn: '[Event "Test"]\n\n1. e4 *',
};
const sourcePgnHash = hashSourcePgn(ownedGame.pgn);
const standardAnalysisDefaults = {
    analysisQuality: 'STANDARD',
    trainingCoveragePreset: 'ALL_CONFIRMED',
    trainingGradingTolerance: 'PRACTICAL',
} as const;
const defaultConfigSnapshot = {
    version: 2,
    engine: null,
    extractor: analysisDefaultsToExtractOptions(standardAnalysisDefaults, {
        returnAnalysis: true,
    }),
};
const defaultConfigHash = hashAnalysisConfig(defaultConfigSnapshot);
const rootFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const rootAssessmentKey = assessmentPositionKey(rootFen, []);

const validAnalysis: GameAnalysis = {
    gameId: 'lichess:source-game-1',
    analyzedAt: '2026-07-04T12:00:00.000Z',
    whiteAccuracy: 91.2,
    blackAccuracy: 84.5,
    trainingExtraction: {
        version: 1,
        trainingSide: 'WHITE',
        thresholds: {
            minWinChanceLoss: 0.03,
            fallbackMinCpLoss: 30,
        },
        budgets: {
            scanNodes: 100_000,
            confirmationBaseNodes: 200_000,
            confirmationMaxNodes: 800_000,
            multiPvStart: 5,
            multiPvMax: 16,
        },
        summary: {
            userDecisions: 1,
            savedPositions: 0,
            unresolvedDecisions: 0,
            reasons: {
                SAVED: 0,
                FORCED_MOVE: 0,
                BELOW_COVERAGE_THRESHOLD: 1,
                BELOW_THRESHOLD_AFTER_CONFIRMATION: 0,
                ANALYSIS_INCOMPLETE: 0,
                VERIFICATION_UNSTABLE: 0,
            },
        },
        decisions: [
            {
                ply: 0,
                status: 'NOT_SAVED',
                reason: 'BELOW_COVERAGE_THRESHOLD',
                cpLoss: 2,
                winChanceLoss: 0.001,
            },
        ],
    },
    moves: [
        {
            ply: 0,
            san: 'e4',
            uci: 'e2e4',
            classification: 'best',
            evalBefore: { type: 'cp', value: 20 },
            evalAfter: { type: 'cp', value: 18 },
            cpLoss: 2,
            accuracy: 99,
            bestMoveUci: 'e2e4',
            bestMoveSan: 'e4',
        },
    ],
};

const solutionCore: Omit<
    SolutionRevisionInput,
    'solutionHash' | 'evidence' | 'generatorVersion' | 'configHash'
> = {
    verificationStatus: 'AMBIGUOUS',
    solutionShape: 'OPEN',
    gradingStrategy: 'OUTCOME_TOLERANCE',
    continuationShape: 'CONDITIONAL_LINE',
    trainable: true,
    bestMoveUci: 'd2d4',
    acceptedMovesUci: ['d2d4'],
    moveAssessments: [
        {
            positionKey: rootAssessmentKey,
            decisionIndex: 0,
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            moveUci: 'd2d4',
            source: 'PRECOMPUTED',
            grade: 'BEST',
            scoreAfter: { kind: 'cp', cp: 40, pov: 'WHITE' },
            evidence: { depth: 20 },
        },
    ],
    bestLineUci: ['d2d4', 'd7d5'],
    solutionTree: {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        ply: 0,
        role: 'USER',
        evidenceSource: 'ENGINE',
        acceptedMovesUci: ['d2d4'],
        alternativesComplete: false,
        branches: [],
        stopReason: 'NO_STABLE_LINE',
    },
    scoreAtStart: { kind: 'cp', cp: 40, pov: 'WHITE' },
    playedMoveScore: { kind: 'cp', cp: -80, pov: 'WHITE' },
    targetOutcome: {
        kind: 'MAXIMIZE_WINNING_CHANCE',
        score: { kind: 'cp', cp: 40, pov: 'WHITE' },
    },
    gradingPolicy: {
        version: 2,
        pov: 'TRAINING_SIDE',
        best: { maxCpLoss: 15, maxWinChanceLoss: 0.02 },
        success: {
            maxCpLoss: 50,
            maxWinChanceLoss: 0.05,
            preserveOutcome: true,
        },
        improvement: {
            minRecoveredCp: 50,
            minRecoveredWinChance: 0.05,
        },
        unknownMove: 'DYNAMIC',
        matePolicy: 'EXACT',
        tablebasePolicy: 'EXACT',
    },
};

const validTrainingMoment: TrainingMomentCandidate = {
    sourceGameId: 'game-1',
    sourceProvider: 'lichess',
    sourcePlayedAt: ownedGame.playedAt.toISOString(),
    sourcePgnHash,
    decisionPly: 0,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    positionHistory: [],
    sideToMove: 'w',
    originalMoveUci: 'e2e4',
    sourceKinds: ['MY_MISTAKE'],
    lessonKinds: ['AVOID_MISTAKE'],
    themes: ['quietMove'],
    originalDecision: {
        scoreBefore: { kind: 'cp', cp: 40, pov: 'WHITE' },
        scoreAfter: { kind: 'cp', cp: -80, pov: 'WHITE' },
        cpLoss: 120,
        winChanceLoss: 0.1,
    },
    confidence: 0.75,
    phase: 'OPENING',
    solution: {
        ...solutionCore,
        solutionHash: solutionSemanticsHash(solutionCore),
        evidence: { fixture: true },
        generatorVersion: 'test-extractor-v2',
        configHash: defaultConfigHash,
    },
};

const validManifest: ExtractionCompletionManifest = {
    version: 1,
    complete: true,
    sourceGameId: 'game-1',
    sourcePgnHash,
    scannedPlies: 1,
    expectedPlies: 1,
    termination: 'COMPLETED',
    errors: [],
};

async function importRoute(): Promise<AnalysisRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();

    return import('@/app/api/games/[id]/analysis/route');
}

function createPutRequest(body: Parameters<typeof createJsonRequest>[1]) {
    return createJsonRequest(
        'http://localhost/api/games/game-1/analysis',
        {
            analysisQuality: 'STANDARD',
            configSnapshot: defaultConfigSnapshot,
            configHash: defaultConfigHash,
            ...(body as Record<string, unknown>),
        },
        { method: 'PUT' }
    );
}

function routeParams() {
    return { params: Promise.resolve({ id: 'game-1' }) };
}

describe('PUT /api/games/[id]/analysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn();
    });

    it('rejects malformed bodies before any write', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: null,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('requires an explicit supported analysis quality', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createJsonRequest(
                'http://localhost/api/games/game-1/analysis',
                {
                    analysis: validAnalysis,
                    trainingMoments: [],
                    extractionManifest: validManifest,
                    configSnapshot: defaultConfigSnapshot,
                },
                { method: 'PUT' }
            ),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysisQuality',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a quality label that does not match the engine budget', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
                analysisQuality: 'THOROUGH',
            }),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Analysis quality does not match configSnapshot',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('requires the current config hash contract', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createJsonRequest(
                'http://localhost/api/games/game-1/analysis',
                {
                    analysis: validAnalysis,
                    trainingMoments: [],
                    extractionManifest: validManifest,
                    analysisQuality: 'STANDARD',
                    configSnapshot: defaultConfigSnapshot,
                },
                { method: 'PUT' }
            ),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'configHash does not match configSnapshot',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects legacy local provenance aliases', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createJsonRequest(
                'http://localhost/api/games/game-1/analysis',
                {
                    analysis: validAnalysis,
                    trainingMoments: [],
                    extractionManifest: validManifest,
                    analysisQuality: 'STANDARD',
                    configSnapshot: defaultConfigSnapshot,
                    configHash: defaultConfigHash,
                    analysisConfigSnapshot: defaultConfigSnapshot,
                    analysisConfigHash: defaultConfigHash,
                    engineName: 'Stockfish',
                },
                { method: 'PUT' }
            ),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis request',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects analysis without the required extraction receipt', async () => {
        const route = await importRoute();
        const analysisWithoutReceipt: Partial<GameAnalysis> = {
            ...validAnalysis,
        };
        delete analysisWithoutReceipt.trainingExtraction;
        const response = await route.PUT(
            createPutRequest({
                analysis: analysisWithoutReceipt,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
    });

    it('rejects non-sequential or fractional analyzed plies before any write', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: {
                    ...validAnalysis,
                    moves: [{ ...validAnalysis.moves[0], ply: 0.5 }],
                },
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects oversized config snapshots before creating a run', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
                configSnapshot: { padding: 'x'.repeat(65_000) },
            }),
            routeParams()
        );

        expect(response.status).toBe(413);
        await expect(readJson(response)).resolves.toEqual({
            error: 'configSnapshot is too large',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('rejects games owned by another user before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(null);

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
        expect(response.status).toBe(404);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects invalid training moments before any write', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [
                    { ...validTrainingMoment, decisionPly: -1 },
                ],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid training moments',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects a self-hashed solution with an illegal line before any write', async () => {
        const route = await importRoute();
        const illegalSolutionCore = {
            ...solutionCore,
            bestLineUci: ['d2d4', 'a1a8'],
        } satisfies typeof solutionCore;
        const illegalMoment: TrainingMomentCandidate = {
            ...validTrainingMoment,
            solution: {
                ...illegalSolutionCore,
                solutionHash:
                    solutionSemanticsHash(illegalSolutionCore),
                evidence: { fixture: true },
                generatorVersion: 'test-extractor-v2',
                configHash: defaultConfigHash,
            },
        };

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [illegalMoment],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid training moments',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate canonical decisions even when their solution hashes differ', async () => {
        const route = await importRoute();
        const alternateSolutionCore: typeof solutionCore = {
            ...solutionCore,
            bestMoveUci: 'g1f3',
            acceptedMovesUci: ['g1f3'],
            moveAssessments: [
                {
                    positionKey: rootAssessmentKey,
                    decisionIndex: 0,
                    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    moveUci: 'g1f3',
                    source: 'PRECOMPUTED',
                    grade: 'BEST',
                    scoreAfter: {
                        kind: 'cp',
                        cp: 40,
                        pov: 'WHITE',
                    },
                    evidence: {
                        bestGapCp: 0,
                        bestGapWinChance: 0,
                    },
                },
            ],
            bestLineUci: ['g1f3', 'g8f6'],
            solutionTree: {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                ply: 0,
                role: 'USER',
                evidenceSource: 'ENGINE',
                acceptedMovesUci: ['g1f3'],
                alternativesComplete: false,
                branches: [],
                stopReason: 'NO_STABLE_LINE',
            },
        };
        const alternateMoment: TrainingMomentCandidate = {
            ...validTrainingMoment,
            solution: {
                ...alternateSolutionCore,
                solutionHash:
                    solutionSemanticsHash(alternateSolutionCore),
                evidence: { fixture: 'alternate' },
                generatorVersion: 'test-extractor-v2',
                configHash: defaultConfigHash,
            },
        };

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [
                    validTrainingMoment,
                    alternateMoment,
                ],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid training moments',
        });
        expect(response.status).toBe(400);
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects analysis for a different source game before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: { ...validAnalysis, gameId: 'lichess:other-game' },
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Analysis game mismatch',
        });
        expect(response.status).toBe(400);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects move analysis that does not match the stored PGN', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: {
                    ...validAnalysis,
                    moves: [
                        {
                            ...validAnalysis.moves[0],
                            san: 'd4',
                            uci: 'd2d4',
                            bestMoveUci: 'd2d4',
                        },
                    ],
                },
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Analysis does not match source PGN',
        });
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('rejects training moments for a different source game before any write', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [
                    { ...validTrainingMoment, sourceGameId: 'other-game' },
                ],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Practice positions do not match source game positions',
        });
        expect(response.status).toBe(400);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('allows a complete empty extraction and saves analysis atomically', async () => {
        const route = await importRoute();
        const analyzedAt = new Date('2026-07-04T12:30:00.000Z');
        const completedRun = {
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            executionMode: 'LOCAL_BROWSER',
            analysisQuality: 'STANDARD',
            creditCost: 0,
            status: 'SUCCEEDED',
            queuedReason: null,
            engineName: null,
            engineVersion: null,
            engineSource: 'local-browser',
            engineFlavor: null,
            engineEvalFile: null,
            engineOptions: {},
            appVersion: null,
            configSnapshot: defaultConfigSnapshot,
            configHash: defaultConfigHash,
            inputPgnHash: sourcePgnHash,
            startedAt: new Date('2026-07-04T12:29:00.000Z'),
            completedAt: analyzedAt,
            durationMs: 60_000,
            consumedCredits: 0,
            lastError: null,
            createdAt: new Date('2026-07-04T12:29:00.000Z'),
            updatedAt: analyzedAt,
        };
        const tx = {
            analysisRun: {
                create: vi.fn().mockResolvedValue({
                    ...completedRun,
                    status: 'RUNNING',
                    completedAt: null,
                    durationMs: null,
                }),
                findFirst: vi.fn().mockResolvedValue({
                    id: 'run-1',
                    userId: 'user-1',
                    gameId: 'game-1',
                    configHash: defaultConfigHash,
                    inputPgnHash: sourcePgnHash,
                    startedAt: new Date('2026-07-04T12:29:00.000Z'),
                }),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue(completedRun),
            },
            analyzedGame: {
                findFirst: vi.fn().mockResolvedValue(ownedGame),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({
                    id: 'game-1',
                    analyzedAt,
                    currentAnalysisRunId: 'run-1',
                }),
            },
            trainingMoment: {
                updateMany: vi.fn().mockResolvedValue({ count: 3 }),
            },
            solutionRevision: {},
            solutionMoveAssessment: {},
            trainingMomentObservation: {},
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
            async (callback) => callback(tx)
        );

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            game: {
                id: 'game-1',
                analyzedAt: analyzedAt.toISOString(),
                currentAnalysisRunId: 'run-1',
            },
            trainingMoments: { upserted: 0, staleArchived: 3 },
            analysisRun: {
                id: 'run-1',
                executionMode: 'LOCAL_BROWSER',
                status: 'SUCCEEDED',
                analysisQuality: 'STANDARD',
                creditCost: 0,
                configHash: defaultConfigHash,
            },
        });
        expect(response.status).toBe(200);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).toHaveBeenCalledWith(
            expect.any(Function),
            ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS
        );
        expect(tx.analysisRun.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                gameId: 'game-1',
                executionMode: 'LOCAL_BROWSER',
                analysisQuality: 'STANDARD',
                creditCost: 0,
                status: 'RUNNING',
                consumedCredits: 0,
            }),
        });
        expect(tx.analyzedGame.updateMany).toHaveBeenCalledWith({
            where: { id: 'game-1', pgn: ownedGame.pgn },
            data: {
                analysis: expect.objectContaining({ gameId: validAnalysis.gameId }),
                analyzedAt: expect.any(Date),
                currentAnalysisRunId: 'run-1',
                currentAnalysisValid: true,
            },
        });
        expect(tx.analysisRun.updateMany).toHaveBeenCalledWith({
            where: { id: 'run-1', status: 'RUNNING' },
            data: expect.objectContaining({
                status: 'SUCCEEDED',
                completedAt: expect.any(Date),
                lastError: null,
            }),
        });
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
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('rolls back run creation with completion failure in one transaction', async () => {
        const route = await importRoute();
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const runningRun = {
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            executionMode: 'LOCAL_BROWSER',
            status: 'RUNNING',
            configHash: defaultConfigHash,
            inputPgnHash: sourcePgnHash,
            startedAt: new Date('2026-07-04T12:29:00.000Z'),
        };
        const tx = {
            analysisRun: {
                create: vi.fn().mockResolvedValue(runningRun),
                findFirst: vi.fn().mockResolvedValue(runningRun),
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn(),
            },
            analyzedGame: {
                findFirst: vi.fn().mockResolvedValue(ownedGame),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({
                    id: 'game-1',
                    analyzedAt: new Date('2026-07-04T12:30:00.000Z'),
                    currentAnalysisRunId: 'run-1',
                }),
            },
            trainingMoment: {
                findUnique: vi.fn().mockResolvedValue(null),
                upsert: vi.fn().mockRejectedValue(new Error('database failed')),
                updateMany: vi.fn(),
            },
            solutionRevision: {},
            solutionMoveAssessment: {},
            trainingMomentObservation: {},
        };

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
            async (callback) => callback(tx)
        );

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [validTrainingMoment],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        await expect(readJson(response)).resolves.toEqual({
            error:
                "We couldn't save this analysis. No changes were written. Retry the analysis.",
            retryable: true,
        });
        expect(response.status).toBe(500);
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).toHaveBeenCalledTimes(1);
        expect(tx.analysisRun.create).toHaveBeenCalled();
        expect(tx.analyzedGame.updateMany).toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).toHaveBeenCalled();
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analysisRun.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('"event":"analysis_persistence_failed"')
        );
        consoleError.mockRestore();
    });

    it('reports an expired persistence transaction as safely retryable', async () => {
        const route = await importRoute();
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const timeoutError = Object.assign(
            new Error('Transaction not found. Internal database details.'),
            { code: 'P2028' }
        );

        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);
        (prismaMock as PrismaMockWithTransaction).$transaction = vi
            .fn()
            .mockRejectedValue(timeoutError);

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(503);
        await expect(readJson(response)).resolves.toEqual({
            error:
                'Saving the analysis took too long. No changes were written. Retry the analysis.',
            retryable: true,
        });
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('"errorCode":"P2028"')
        );
        consoleError.mockRestore();
    });
});
