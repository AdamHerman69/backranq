import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const momentId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const clientAttemptId =
    '33333333-3333-4333-8333-333333333333';
const feedRow = {
    id: momentId,
    currentSolutionRevisionId: revisionId,
    fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
    sideToMove: 'w',
    positionHistory: [],
    gameId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionPly: 0,
    originalMoveUci: 'e2f2',
    scoreBefore: { kind: 'cp', cp: 80, pov: 'WHITE' },
    scoreAfter: { kind: 'cp', cp: 0, pov: 'WHITE' },
    cpLoss: 80,
    winChanceLoss: 0.1,
    sourceKinds: ['MY_MISTAKE'],
    lessonKinds: ['AVOID_MISTAKE'],
    themes: ['quiet-move'],
    game: {
        provider: 'LICHESS',
        playedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    currentSolutionRevision: {
        bestMoveUci: 'e2e3',
        acceptedMovesUci: ['e2e3'],
        acceptanceFrontier: {
            version: 1,
            status: 'STABLE',
            targetCutoffCp: 100,
            effectiveCutoffCp: 70,
            boundaryGapCp: 40,
            moves: [{ moveUci: 'e2e3', tier: 'BEST' }],
            firstRejectedMoveUci: 'e2f2',
        },
        solutionShape: 'UNIQUE',
        bestLine: ['e2e3'],
        scoreAtStart: { kind: 'cp', cp: 80, pov: 'WHITE' },
        gradingPolicy: {
            version: 3,
            pov: 'TRAINING_SIDE',
            best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
            strong: { maxCpLoss: 50, maxWinChanceLoss: 0.05 },
            success: {
                maxCpLoss: 100,
                maxWinChanceLoss: 0.1,
                preserveOutcome: true,
            },
            improvement: {
                minRecoveredCp: 40,
                minRecoveredWinChance: 0.05,
            },
            unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET',
            matePolicy: 'EXACT',
            tablebasePolicy: 'EXACT',
        },
        solutionTree: {
            fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
            ply: 0,
            role: 'USER',
            acceptedMovesUci: ['e2e3'],
            alternativesComplete: true,
            branches: [
                {
                    moveUci: 'e2e3',
                    best: true,
                    child: {
                        fen: '8/8/8/8/8/4K3/8/6k1 b - - 1 1',
                        ply: 1,
                        role: 'TERMINAL',
                        acceptedMovesUci: [],
                        alternativesComplete: true,
                        branches: [],
                    },
                },
            ],
        },
        moveAssessments: [
            {
                decisionIndex: 0,
                fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                moveUci: 'e2e3',
                source: 'PRECOMPUTED',
                status: 'VERIFIED',
                grade: 'BEST',
                scoreAfter: {
                    kind: 'cp',
                    cp: 80,
                    pov: 'WHITE',
                },
                evidence: { bestGapCp: 0 },
            },
        ],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastTrainedAt: null,
};

function prepareRouteModules() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
}

describe('canonical training routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('requires authentication on every pre-attempt and write endpoint', async () => {
        prepareRouteModules();
        setMockUserId(null);
        const [feedRoute, detailRoute, attemptRoute] =
            await Promise.all([
                import('@/app/api/training/feed/route'),
                import('@/app/api/training/moments/[id]/route'),
                import('@/app/api/training/moments/[id]/attempts/route'),
            ]);

        const responses = await Promise.all([
            feedRoute.GET(
                new Request('http://localhost/api/training/feed')
            ),
            detailRoute.GET(new Request('http://localhost'), {
                params: Promise.resolve({ id: momentId }),
            }),
            attemptRoute.POST(
                createJsonRequest('http://localhost', {
                    kind: 'RECORD',
                    clientAttemptId,
                    solutionRevisionId: revisionId,
                    status: 'REVEALED',
                    steps: [],
                }),
                { params: Promise.resolve({ id: momentId }) }
            ),
        ]);

        expect(responses.map((response) => response.status)).toEqual([
            401, 401, 401,
        ]);
        for (const response of responses) {
            await expect(readJson(response)).resolves.toEqual({
                error: 'Unauthorized',
                code: 'UNAUTHORIZED',
            });
        }
        expect(prismaMock.trainingMoment.findMany).not.toHaveBeenCalled();
        expect(prismaMock.trainingAttempt.create).not.toHaveBeenCalled();
    });

    it('returns local grading data and scopes reads to the user', async () => {
        prepareRouteModules();
        prismaMock.trainingMoment.findMany.mockResolvedValue([feedRow]);
        const route = await import('@/app/api/training/feed/route');

        const response = await route.GET(
            new Request('http://localhost/api/training/feed?limit=10')
        );

        expect(response.status).toBe(200);
        const body = await readJson<{
            items: Array<Record<string, unknown>>;
            nextCursor: string | null;
            appliedFilters: Record<string, unknown>;
        }>(response);
        expect(body).toMatchObject({
            items: [
                {
                    id: momentId,
                    solutionRevisionId: revisionId,
                    grading: {
                        originalMoveUci: 'e2f2',
                        moveAssessments: [
                            expect.objectContaining({
                                moveUci: 'e2e3',
                                grade: 'BEST',
                            }),
                        ],
                    },
                },
            ],
        });
        expect(prismaMock.trainingMoment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: 'user-1' }),
            })
        );
    });

    it('applies the saved practice mix without changing extracted moments', async () => {
        prepareRouteModules();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                trainingSessionMix: 'MISSED_OPPORTUNITIES',
            },
        });
        prismaMock.trainingMoment.findMany.mockResolvedValue([]);
        const route = await import('@/app/api/training/feed/route');

        const response = await route.GET(
            new Request('http://localhost/api/training/feed?limit=10')
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            appliedFilters: {
                sourceKinds: ['MISSED_OPPORTUNITY'],
            },
        });
        expect(prismaMock.trainingMoment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sourceKinds: {
                        hasSome: ['MISSED_OPPORTUNITY'],
                    },
                }),
            })
        );
    });

    it('freezes a saved ALL mix across cursor pagination', async () => {
        prepareRouteModules();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: { trainingSessionMix: 'ALL' },
        });
        prismaMock.trainingMoment.findMany.mockResolvedValueOnce([
            {
                ...feedRow,
            },
            {
                ...feedRow,
                id: '44444444-4444-4444-8444-444444444444',
                createdAt: new Date('2026-01-02T00:00:00.000Z'),
            },
        ]);
        const route = await import('@/app/api/training/feed/route');

        const first = await route.GET(
            new Request(
                'http://localhost/api/training/feed?limit=1'
            )
        );
        const firstBody = await readJson<{
            nextCursor: string;
            appliedFilters: Record<string, unknown>;
        }>(first);
        expect(firstBody.appliedFilters).toEqual({});

        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                trainingSessionMix: 'MISSED_OPPORTUNITIES',
            },
        });
        prismaMock.trainingMoment.findMany.mockResolvedValueOnce([]);
        const second = await route.GET(
            new Request(
                `http://localhost/api/training/feed?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`
            )
        );

        expect(second.status).toBe(200);
        await expect(readJson(second)).resolves.toMatchObject({
            appliedFilters: {},
        });
        expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed write bodies before touching attempt data', async () => {
        prepareRouteModules();
        const route = await import(
            '@/app/api/training/moments/[id]/attempts/route'
        );

        const response = await route.POST(
            createJsonRequest('http://localhost', {
                kind: 'RECORD',
                clientAttemptId,
                solutionRevisionId: revisionId,
                status: 'GRADED',
                grade: 'BEST',
            }),
            { params: Promise.resolve({ id: momentId }) }
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid training attempt request',
            code: 'INVALID_REQUEST',
        });
        expect(prismaMock.trainingAttempt.create).not.toHaveBeenCalled();
    });
});
