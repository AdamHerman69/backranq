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
        const [sessionRoute, detailRoute, attemptRoute, revealRoute] =
            await Promise.all([
                import('@/app/api/training/session/route'),
                import('@/app/api/training/moments/[id]/route'),
                import('@/app/api/training/moments/[id]/attempts/route'),
                import('@/app/api/training/moments/[id]/reveal/route'),
            ]);

        const responses = await Promise.all([
            sessionRoute.GET(
                new Request('http://localhost/api/training/session')
            ),
            detailRoute.GET(new Request('http://localhost'), {
                params: Promise.resolve({ id: momentId }),
            }),
            attemptRoute.POST(
                createJsonRequest('http://localhost', {
                    kind: 'START',
                    clientAttemptId,
                    solutionRevisionId: revisionId,
                    moveUci: 'e2e4',
                }),
                { params: Promise.resolve({ id: momentId }) }
            ),
            revealRoute.POST(
                createJsonRequest('http://localhost', {
                    clientAttemptId,
                    solutionRevisionId: revisionId,
                }),
                { params: Promise.resolve({ id: momentId }) }
            ),
        ]);

        expect(responses.map((response) => response.status)).toEqual([
            401, 401, 401, 401,
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

    it('keeps the session response spoiler-free and scopes reads to the user', async () => {
        prepareRouteModules();
        prismaMock.trainingMoment.findMany.mockResolvedValue([
            {
                id: momentId,
                currentSolutionRevisionId: revisionId,
                fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                sideToMove: 'w',
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                originalMoveUci: 'e2f2',
                bestMoveUci: 'e2e3',
                themes: ['quiet-move'],
            },
        ]);
        const route = await import('@/app/api/training/session/route');

        const response = await route.GET(
            new Request('http://localhost/api/training/session?limit=10')
        );

        expect(response.status).toBe(200);
        const body = await readJson<{
            items: Array<Record<string, unknown>>;
            nextCursor: string | null;
            appliedFilters: Record<string, unknown>;
        }>(response);
        expect(body).toEqual({
            items: [
                {
                    id: momentId,
                    solutionRevisionId: revisionId,
                    fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                    sideToMove: 'w',
                },
            ],
            nextCursor: null,
            appliedFilters: {},
        });
        expect(prismaMock.trainingMoment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: 'user-1' }),
            })
        );
    });

    it('applies the saved session mix without changing extracted moments', async () => {
        prepareRouteModules();
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                trainingSessionMix: 'MISSED_OPPORTUNITIES',
            },
        });
        prismaMock.trainingMoment.findMany.mockResolvedValue([]);
        const route = await import('@/app/api/training/session/route');

        const response = await route.GET(
            new Request('http://localhost/api/training/session?limit=10')
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
                id: momentId,
                currentSolutionRevisionId: revisionId,
                fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                sideToMove: 'w',
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                lastTrainedAt: null,
            },
            {
                id: '44444444-4444-4444-8444-444444444444',
                currentSolutionRevisionId: revisionId,
                fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
                sideToMove: 'w',
                createdAt: new Date('2026-01-02T00:00:00.000Z'),
                lastTrainedAt: null,
            },
        ]);
        const route = await import('@/app/api/training/session/route');

        const first = await route.GET(
            new Request(
                'http://localhost/api/training/session?limit=1'
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
                `http://localhost/api/training/session?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`
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
                kind: 'START',
                clientAttemptId,
                moveUci: 'e2e4',
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
