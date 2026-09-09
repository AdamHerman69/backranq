import { emptyExtractionWork } from '@/lib/analysis/extractionWork';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { ExtractionCompletionManifest } from '@/lib/analysis/extractTrainingMoments';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    ANALYSIS_PERSISTENCE_TRANSACTION_OPTIONS,
    hashAnalysisConfig,
} from '@/lib/services/analysisRuns';
import {
    type SolutionRevisionInput,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import { createExtractionConfigSnapshot } from '@/lib/analysis/extractionConfig';
import { resolveTrainingMomentExtractionOptions } from '@/lib/analysis/extractTrainingMoments';
import { emptyExtractionReasonCounts } from '@/lib/analysis/extractionReceipt';
import { analysisDefaultsToExtractOptions } from '@/lib/preferences';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
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
    sourceUsername: 'Ada',
    userSide: 'WHITE',
    whiteName: 'Ada',
    blackName: 'Grace',
};
const sourcePgnHash = hashSourcePgn(ownedGame.pgn);
const standardAnalysisDefaults = {
    analysisQuality: 'STANDARD',
    trainingCoveragePreset: 'ALL_CONFIRMED',
    trainingGradingTolerance: 'PRACTICAL',
} as const;
const defaultConfigSnapshot = createExtractionConfigSnapshot({
    engine: null,
    extractor: resolveTrainingMomentExtractionOptions(analysisDefaultsToExtractOptions(standardAnalysisDefaults, {
        returnAnalysis: true,
    })),
});
const defaultConfigHash = hashAnalysisConfig(defaultConfigSnapshot);


const validAnalysis: GameAnalysis = {
    gameId: 'lichess:source-game-1',
    analyzedAt: '2026-07-04T12:00:00.000Z',
    whiteAccuracy: 91.2,
    blackAccuracy: 84.5,
    trainingExtraction: {
        version: 2,
        engineWork: emptyExtractionWork(),
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
            reasons: { ...emptyExtractionReasonCounts(), BELOW_CANDIDATE_SIGNAL: 1 },
        },
        decisions: [
            {
                ply: 0,
                status: 'NOT_SAVED',
                reason: 'BELOW_CANDIDATE_SIGNAL',
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

const practiceManifest = practiceV4Fixture();
practiceManifest.source = { ...practiceManifest.source, gameId: ownedGame.id, sourcePgnHash, originalMoveUci: 'e2e4' };
practiceManifest.rootAnswerIndex.preferredMoveUci = 'd2d4';
practiceManifest.frames[0].referenceAssessmentId = 'assessment-d2d4';
practiceManifest.executionProfileId = defaultConfigHash;
practiceManifest.executionProfileSnapshot = { id: defaultConfigHash, minimumConfirmationNodes: defaultConfigSnapshot.extractor.confirmNodes ?? 1 };
practiceManifest.policySnapshot = defaultConfigSnapshot.extractor.gradingPolicy;
for (const search of Object.values(practiceManifest.evidence.searches)) {
    if (search.reason === 'VERIFY_REFERENCE') {
        search.request.rootScopeUci = ['d2d4'];
    } else {
        search.request.limit.nodes = practiceManifest.executionProfileSnapshot.minimumConfirmationNodes;
        search.reportedNodes = practiceManifest.executionProfileSnapshot.minimumConfirmationNodes;
    }
}
for (const observation of Object.values(practiceManifest.evidence.observations)) {
    if (practiceManifest.evidence.searches[observation.searchId].reason === 'VERIFY_REFERENCE') {
        observation.rootScopeUci = ['d2d4'];
        observation.lines = [{ ...observation.lines[0], moveUci: 'd2d4', pvUci: ['d2d4'], score: { kind: 'CP', pov: 'WHITE', cp: 20 } }];
    } else {
        observation.nodes *= practiceManifest.executionProfileSnapshot.minimumConfirmationNodes / 100_000;
    }
    observation.lines = observation.lines.map(line => line.moveUci === 'e2e4' ? { ...line, score: { kind: 'CP' as const, pov: 'WHITE' as const, cp: -200 } } : line).sort((a,b) => (b.score.kind === 'CP' ? b.score.cp : 0) - (a.score.kind === 'CP' ? a.score.cp : 0));
}
rebuildPracticeFixture(practiceManifest);
const solutionCore: SolutionRevisionInput = { manifest: practiceManifest, configHash: defaultConfigHash };

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
    originalDecision: originalDecisionForPracticeManifest(practiceManifest),
    confidence: 0.75,
    phase: 'OPENING',
    solution: solutionCore,
};

const validManifest: ExtractionCompletionManifest = {
    scope: 'FULL_GAME', scanComplete: true, extractionComplete: true,
    decisionOutcomes: [],
    version: 1,
    complete: true,
    sourceGameId: 'game-1',
    sourcePgnHash,
    scannedPlies: 1,
    expectedPlies: 1,
    termination: 'COMPLETED',
    errors: [],
};

const confirmedManifest: ExtractionCompletionManifest = { ...validManifest, decisionOutcomes: [{ decisionPly: 0, status: practiceManifest.decision.status, reason: practiceManifest.decision.reason }] };

async function importRoute(): Promise<AnalysisRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/notifications/service', () => ({
        recordPracticeReadyInTransaction: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/notifications/delivery', () => ({
        dispatchPendingNotificationDeliveries: vi.fn().mockResolvedValue({}),
    }));

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
        {
            method: 'PUT',
            headers: { [EXPECTED_OWNER_HEADER]: 'user-1' },
        }
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

    it('rejects a stale owner before parsing or writing', async () => {
        const route = await importRoute();
        const response = await route.PUT(
            new Request('http://localhost/api/games/game-1/analysis', {
                method: 'PUT',
                headers: { [EXPECTED_OWNER_HEADER]: 'user-a' },
                body: 'not-json',
            }),
            routeParams()
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'OWNER_MISMATCH',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
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
                {
                    method: 'PUT',
                    headers: { [EXPECTED_OWNER_HEADER]: 'user-1' },
                }
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
                {
                    method: 'PUT',
                    headers: { [EXPECTED_OWNER_HEADER]: 'user-1' },
                }
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
                {
                    method: 'PUT',
                    headers: { [EXPECTED_OWNER_HEADER]: 'user-1' },
                }
            ),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid analysis request',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it.each(['selectionPolicyId', 'multiPv'] as const)('rejects a T2 snapshot with mismatched %s before data access', async (field) => {
        const route = await importRoute();
        const snapshot = createExtractionConfigSnapshot({ engine: null,
            extractor: resolveTrainingMomentExtractionOptions(analysisDefaultsToExtractOptions({
                ...standardAnalysisDefaults, analysisQuality: 'T2',
            }, { returnAnalysis: true })),
        });
        if (field === 'selectionPolicyId') snapshot.extractor.selectionPolicyId = defaultConfigSnapshot.extractor.selectionPolicyId;
        else snapshot.extractor.multiPv = 5;
        const response = await route.PUT(createPutRequest({ analysis: validAnalysis, trainingMoments: [],
            extractionManifest: validManifest, analysisQuality: 'T2', configSnapshot: snapshot,
            configHash: hashAnalysisConfig(snapshot),
        }), routeParams());
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({ error: 'Analysis quality does not match configSnapshot' });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect((prismaMock as PrismaMockWithTransaction).$transaction).not.toHaveBeenCalled();
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

    it('rejects contradictory diagnostic and canonical decisions before opening a transaction', async () => {
        const route = await importRoute();
        const response = await route.PUT(createPutRequest({ analysis: validAnalysis, trainingMoments: [validTrainingMoment], extractionManifest: { ...confirmedManifest, decisionOutcomes: [{ decisionPly: 0, status: 'NOT_A_MISTAKE', reason: 'CONTRADICTORY_DIAGNOSTIC' }] } }), routeParams());
        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({ error: 'Extraction diagnostics contradict canonical practice decisions' });
        expect((prismaMock as PrismaMockWithTransaction).$transaction).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
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
        const illegalSolutionCore = structuredClone(solutionCore);
        illegalSolutionCore.manifest.continuation.explanationLines = [{ startContextId: practiceManifest.source.contextId, movesUci: ['d2d4', 'a1a8'], stopReason: 'TEST' }];
        illegalSolutionCore.manifest.semanticHash = solutionSemanticsHash(illegalSolutionCore);
        const illegalMoment: TrainingMomentCandidate = { ...validTrainingMoment, solution: illegalSolutionCore };

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
        const alternateSolutionCore = structuredClone(solutionCore);
        alternateSolutionCore.manifest.continuation.explanationLines = [{ startContextId: practiceManifest.source.contextId, movesUci: ['d2d4'], stopReason: 'TEST' }];
        alternateSolutionCore.manifest.semanticHash = solutionSemanticsHash(alternateSolutionCore);
        const alternateMoment: TrainingMomentCandidate = { ...validTrainingMoment, solution: alternateSolutionCore };

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
            error: 'Duplicate training decision',
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

    it('rejects an analysis receipt for the opposite frozen perspective', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(ownedGame);

        const response = await route.PUT(
            createPutRequest({
                analysis: {
                    ...validAnalysis,
                    trainingExtraction: {
                        ...validAnalysis.trainingExtraction,
                        trainingSide: 'BLACK',
                    },
                },
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Analysis perspective does not match stored game',
        });
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('fails closed when the stored perspective no longer matches the players', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            ...ownedGame,
            sourceUsername: 'Mallory',
        });

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Stored game perspective is invalid',
        });
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
    });

    it('fails closed on an UNKNOWN stored side even if legacy data reaches runtime', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue({
            ...ownedGame,
            userSide: 'UNKNOWN',
        });

        const response = await route.PUT(
            createPutRequest({
                analysis: validAnalysis,
                trainingMoments: [],
                extractionManifest: validManifest,
            }),
            routeParams()
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Stored game perspective is invalid',
        });
        expect(
            (prismaMock as PrismaMockWithTransaction).$transaction
        ).not.toHaveBeenCalled();
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
            error: 'Invalid training moments',
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
                upsert: vi.fn(),
                updateMany: vi.fn().mockResolvedValue({ count: 3 }),
            },
            solutionRevision: {},
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
                extractionManifest: { ...validManifest, decisionOutcomes: [{ decisionPly: 0, status: 'UNRESOLVED', reason: 'MISTAKE_COMPARISON_UNRESOLVED' }] },
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
            trainingMoments: { upserted: 0, staleArchived: 0 },
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
                whiteAccuracy: validAnalysis.whiteAccuracy,
                blackAccuracy: validAnalysis.blackAccuracy,
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
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.update).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it.each([
        ['MANUAL_PGN', 'manual_pgn'],
        ['BACKRANQ_COACH', 'backranq_coach'],
    ] as const)(
        'persists a nonempty Practice moment for %s through the production route',
        async (dbProvider, uiProvider) => {
            const route = await importRoute();
            const sourceGame = {
                ...ownedGame,
                provider: dbProvider,
                externalId: `${uiProvider}-source-1`,
            };
            const analysis = {
                ...validAnalysis,
                gameId: `${uiProvider}:${sourceGame.externalId}`,
            };
            const moment = {
                ...validTrainingMoment,
                sourceProvider: uiProvider,
            };
            const runningRun = {
                id: 'run-source-1',
                userId: 'user-1',
                gameId: 'game-1',
                status: 'RUNNING',
                configHash: defaultConfigHash,
                configSnapshot: defaultConfigSnapshot,
                inputPgnHash: sourcePgnHash,
                startedAt: new Date('2026-07-04T12:29:00.000Z'),
            };
            const tx = {
                analysisRun: {
                    create: vi.fn().mockResolvedValue(runningRun),
                    findFirst: vi.fn().mockResolvedValue(runningRun),
                    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                    findUniqueOrThrow: vi.fn().mockResolvedValue({
                        ...runningRun,
                        status: 'SUCCEEDED',
                        executionMode: 'LOCAL_BROWSER',
                        analysisQuality: 'STANDARD',
                        creditCost: 0,
                    }),
                },
                analyzedGame: {
                    findFirst: vi.fn().mockResolvedValue(sourceGame),
                    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                    findUniqueOrThrow: vi.fn().mockResolvedValue({
                        id: 'game-1',
                        analyzedAt: new Date('2026-07-04T12:30:00.000Z'),
                        currentAnalysisRunId: 'run-source-1',
                    }),
                },
                trainingMoment: {
                    findUnique: vi.fn().mockResolvedValue(null),
                    upsert: vi.fn().mockResolvedValue({ id: 'moment-1' }),
                    update: vi.fn().mockResolvedValue({ id: 'moment-1' }),
                    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                },
                solutionRevision: {
                    findFirst: vi.fn().mockResolvedValue(null),
                    create: vi.fn().mockResolvedValue({
                        id: 'revision-1',
                        momentId: 'moment-1',
                        solutionHash: validTrainingMoment.solution.manifest.semanticHash,
                    }),
                },
                trainingMomentObservation: {
                    findUnique: vi.fn().mockResolvedValue(null),
                    create: vi.fn().mockResolvedValue({ id: 'observation-1' }),
                },
            };
            prismaMock.analyzedGame.findFirst.mockResolvedValue(sourceGame);
            (prismaMock as PrismaMockWithTransaction).$transaction = vi.fn(
                async (callback) => callback(tx)
            );

            const response = await route.PUT(
                createPutRequest({
                    analysis,
                    trainingMoments: [moment],
                    extractionManifest: confirmedManifest,
                }),
                routeParams()
            );

            expect(response.status).toBe(200);
            await expect(readJson(response)).resolves.toMatchObject({
                ok: true,
                trainingMoments: { upserted: 1 },
            });
            expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        sourceKinds: ['MY_MISTAKE'],
                        lessonKinds: ['AVOID_MISTAKE'],
                    }),
                })
            );
            expect(tx.solutionRevision.create).toHaveBeenCalled();
            expect(tx.trainingMomentObservation.create).toHaveBeenCalled();
        }
    );

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
            configSnapshot: defaultConfigSnapshot,
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
                extractionManifest: confirmedManifest,
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
