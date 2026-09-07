import { practiceV4Fixture } from '../helpers/practice-v4';
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalPracticeSemantics } from '@/lib/training/practiceContract';
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
const manifest = practiceV4Fixture();
manifest.momentId = momentId; manifest.revisionId = revisionId;
manifest.source.gameId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
manifest.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(manifest))).digest('hex');
const feedRow = {
    id: momentId,
    currentSolutionRevisionId: revisionId,
    fen: manifest.source.fen,
    sideToMove: 'w',
    positionHistory: [],
    gameId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionPly: 0,
    originalMoveUci: 'a2a3',
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
    currentSolutionRevision: { manifest, trainable: true },
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
        prismaMock.$queryRaw.mockImplementation(
            async (query: unknown) => {
                const text = (
                    query as { strings?: readonly string[] }
                ).strings?.join('');
                if (text?.includes('WITH "rawDue" AS MATERIALIZED')) {
                    return [];
                }
                return [
                    {
                        rawId: momentId,
                        id: momentId,
                        currentSolutionRevisionId: revisionId,
                        createdAt: feedRow.createdAt,
                    },
                ];
            }
        );
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
                    completedAt: '2026-07-30T08:00:00.000Z',
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
        expect(response.headers.get('server-timing')).toMatch(
            /auth;dur=.*preferences;dur=.*feed;dur=.*db_ops_sum;dur=.*total;dur=/
        );
        expect(response.headers.get('x-backranq-db-operation-count')).toBe(
            '0'
        );
        const body = await readJson<{
            ownerId: string;
            items: Array<Record<string, unknown>>;
            nextCursor: string | null;
            appliedFilters: Record<string, unknown>;
        }>(response);
        expect(body).toMatchObject({
            ownerId: 'user-1',
            items: [
                {
                    id: momentId,
                    solutionRevisionId: revisionId,
                    grading: {
                        source: expect.objectContaining({originalMoveUci: 'a2a3'}),
                        assessments: expect.arrayContaining([
                            expect.objectContaining({
                                moveUci: 'e2e4',
                                tier: 'BEST', quality: 'GOOD',
                            }),
                        ]),
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

    it('returns the authenticated owner with a training moment detail', async () => {
        prepareRouteModules();
        prismaMock.trainingMoment.findFirst.mockResolvedValue(feedRow);
        const route = await import(
            '@/app/api/training/moments/[id]/route'
        );

        const response = await route.GET(
            new Request(`http://localhost/api/training/moments/${momentId}`),
            { params: Promise.resolve({ id: momentId }) }
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            moment: { id: momentId, solutionRevisionId: revisionId },
        });
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
        expect(prismaMock.$queryRaw).toHaveBeenCalledWith(
            expect.objectContaining({
                values: expect.arrayContaining(['MISSED_OPPORTUNITY']),
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
        let newPage = 0;
        prismaMock.$queryRaw.mockImplementation(
            async (query: unknown) => {
                const text = (
                    query as { strings?: readonly string[] }
                ).strings?.join('');
                if (text?.includes('WITH "rawDue" AS MATERIALIZED')) {
                    return [];
                }
                newPage += 1;
                return newPage === 1
                    ? [
                          {
                              rawId: momentId,
                              id: momentId,
                              currentSolutionRevisionId: revisionId,
                              createdAt: feedRow.createdAt,
                          },
                          {
                              rawId: '44444444-4444-4444-8444-444444444444',
                              id: '44444444-4444-4444-8444-444444444444',
                              currentSolutionRevisionId: revisionId,
                              createdAt: new Date(
                                  '2026-01-02T00:00:00.000Z'
                              ),
                          },
                      ]
                    : [];
            }
        );
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
                completedAt: '2026-07-30T08:00:00.000Z',
                clientAttemptId,
                solutionRevisionId: revisionId,
                status: 'GRADED',
                grade: 'BEST',
            }, {
                headers: { 'X-Backranq-Owner-Id': 'user-1' },
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

    it('rejects a training write captured for a different signed-in owner', async () => {
        prepareRouteModules();
        const route = await import(
            '@/app/api/training/moments/[id]/attempts/route'
        );

        const response = await route.POST(
            createJsonRequest(
                'http://localhost',
                {
                    kind: 'RECORD',
                    completedAt: '2026-07-30T08:00:00.000Z',
                    clientAttemptId,
                    solutionRevisionId: revisionId,
                    status: 'REVEALED',
                    steps: [],
                },
                { headers: { 'X-Backranq-Owner-Id': 'user-2' } }
            ),
            { params: Promise.resolve({ id: momentId }) }
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'OWNER_MISMATCH',
        });
        expect(prismaMock.trainingAttempt.create).not.toHaveBeenCalled();
    });
});
