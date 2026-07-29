import { describe, expect, it, vi } from 'vitest';
import {
    getTrainingMomentPrompt,
    InvalidTrainingCursorError,
    listTrainingSession,
} from '@/lib/training/readService';
import {
    parseSubmitTrainingAttemptRequest,
    parseTrainingSessionRequest,
} from '@/lib/training/apiValidation';

const promptRow = {
    id: '11111111-1111-4111-8111-111111111111',
    currentSolutionRevisionId:
        '22222222-2222-4222-8222-222222222222',
    fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
    sideToMove: 'w',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastTrainedAt: null,
};

describe('canonical training API boundary', () => {
    it('returns exactly the four spoiler-safe prompt fields', async () => {
        const db = {
            trainingMoment: {
                findMany: vi.fn().mockResolvedValue([
                    {
                        ...promptRow,
                        originalMoveUci: 'e2f2',
                        bestMoveUci: 'e2e3',
                        themes: ['quiet-move'],
                    },
                ]),
                findFirst: vi.fn().mockResolvedValue({
                    ...promptRow,
                    originalMoveUci: 'e2f2',
                    bestMoveUci: 'e2e3',
                    themes: ['quiet-move'],
                }),
            },
        };

        const session = await listTrainingSession({
            db: db as never,
            userId: 'user-1',
            request: { limit: 10 },
        });
        const detail = await getTrainingMomentPrompt({
            db: db as never,
            userId: 'user-1',
            momentId: promptRow.id,
        });

        const expected = {
            id: promptRow.id,
            solutionRevisionId:
                promptRow.currentSolutionRevisionId,
            fen: promptRow.fen,
            sideToMove: 'w',
        };
        expect(session).toEqual({
            items: [expected],
            nextCursor: null,
            appliedFilters: {},
        });
        expect(detail).toEqual({ moment: expected });
        expect(Object.keys(session.items[0]!).sort()).toEqual(
            ['fen', 'id', 'sideToMove', 'solutionRevisionId'].sort()
        );
        expect(db.trainingMoment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: {
                    id: true,
                    currentSolutionRevisionId: true,
                    fen: true,
                    sideToMove: true,
                    createdAt: true,
                    lastTrainedAt: true,
                },
            })
        );
    });

    it('schedules unseen moments first and keeps a completed corpus reviewable', async () => {
        const reviewedAt = new Date('2026-02-01T00:00:00.000Z');
        const db = {
            trainingMoment: {
                findMany: vi.fn().mockResolvedValue([
                    {
                        ...promptRow,
                        lastTrainedAt: reviewedAt,
                    },
                ]),
            },
        };

        const session = await listTrainingSession({
            db: db as never,
            userId: 'user-1',
            request: { limit: 10 },
        });

        expect(session.items).toHaveLength(1);
        const call = db.trainingMoment.findMany.mock.calls[0]![0];
        expect(call.where).not.toHaveProperty('attempts');
        expect(call.orderBy).toEqual([
            {
                lastTrainedAt: {
                    sort: 'asc',
                    nulls: 'first',
                },
            },
            { createdAt: 'asc' },
            { id: 'asc' },
        ]);
    });

    it.each([
        {
            focus: 'MEANINGFUL' as const,
            minWinChanceLoss: 0.08,
            fallbackMinCpLoss: 100,
        },
        {
            focus: 'MAJOR' as const,
            minWinChanceLoss: 0.12,
            fallbackMinCpLoss: 150,
        },
    ])(
        'applies $focus with win-chance-primary and cp-fallback semantics',
        async ({
            focus,
            minWinChanceLoss,
            fallbackMinCpLoss,
        }) => {
            const findMany = vi.fn().mockResolvedValue([]);
            await listTrainingSession({
                db: {
                    trainingMoment: { findMany },
                } as never,
                userId: 'user-1',
                request: {
                    limit: 10,
                    filters: { focus },
                },
            });

            expect(findMany.mock.calls[0]![0].where.AND).toEqual(
                expect.arrayContaining([
                    {
                        OR: [
                            {
                                winChanceLoss: {
                                    gte: minWinChanceLoss,
                                },
                            },
                            {
                                winChanceLoss: null,
                                cpLoss: {
                                    gte: fallbackMinCpLoss,
                                },
                            },
                        ],
                    },
                ])
            );
        }
    );

    it('uses a stable session snapshot so mutable review timestamps cannot repeat pages', async () => {
        const rows = Array.from({ length: 13 }, (_, index) => ({
            ...promptRow,
            id: `moment-${String(index).padStart(2, '0')}`,
            createdAt: new Date(
                Date.UTC(2026, 0, 1, 0, index)
            ),
            lastTrainedAt:
                index < 4
                    ? null
                    : new Date(
                          Date.UTC(2026, 1, 1, 0, index)
                      ),
        }));
        const pages = [
            rows.slice(0, 6),
            rows.slice(5, 11),
            rows.slice(10),
        ];
        const findMany = vi
            .fn()
            .mockImplementation(async () => pages.shift() ?? []);
        const db = { trainingMoment: { findMany } };
        const seen: string[] = [];
        let cursor: string | undefined;

        do {
            const page = await listTrainingSession({
                db: db as never,
                userId: 'user-1',
                request: { limit: 5, cursor },
            });
            seen.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);

        expect(seen).toHaveLength(13);
        expect(new Set(seen).size).toBe(13);
        expect(findMany).toHaveBeenCalledTimes(3);
        const secondWhere =
            findMany.mock.calls[1]![0].where;
        expect(secondWhere.AND).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    createdAt: {
                        lte: expect.any(Date),
                    },
                }),
                expect.objectContaining({
                    OR: [
                        { lastTrainedAt: null },
                        {
                            lastTrainedAt: {
                                lt: expect.any(Date),
                            },
                        },
                    ],
                }),
            ])
        );
    });

    it('rejects a cursor that forges a future session snapshot', async () => {
        const findMany = vi.fn().mockResolvedValue([
            promptRow,
            {
                ...promptRow,
                id: 'moment-next',
                createdAt: new Date('2026-01-01T00:01:00.000Z'),
            },
        ]);
        const db = {
            trainingMoment: {
                findMany,
            },
        };
        const first = await listTrainingSession({
            db: db as never,
            userId: 'user-1',
            request: { limit: 1 },
        });
        const decoded = JSON.parse(
            Buffer.from(
                first.nextCursor!,
                'base64url'
            ).toString('utf8')
        ) as Record<string, unknown>;
        const cursor = Buffer.from(
            JSON.stringify({
                ...decoded,
                sessionStartedAt: '2999-01-01T00:00:00.000Z',
            }),
            'utf8'
        ).toString('base64url');

        await expect(
            listTrainingSession({
                db: db as never,
                userId: 'user-1',
                request: { limit: 5, cursor },
            })
        ).rejects.toBeInstanceOf(InvalidTrainingCursorError);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('binds a session cursor to its normalized filters', async () => {
        const findMany = vi
            .fn()
            .mockResolvedValueOnce([
                promptRow,
                {
                    ...promptRow,
                    id: 'moment-next',
                    createdAt: new Date(
                        '2026-01-01T00:01:00.000Z'
                    ),
                },
            ])
            .mockResolvedValueOnce([]);
        const db = { trainingMoment: { findMany } };
        const first = await listTrainingSession({
            db: db as never,
            userId: 'user-1',
            request: {
                limit: 1,
                filters: {
                    focus: 'MEANINGFUL',
                    themes: ['defense', 'quiet-move'],
                },
            },
        });
        expect(first.nextCursor).toEqual(expect.any(String));

        await expect(
            listTrainingSession({
                db: db as never,
                userId: 'user-1',
                request: {
                    limit: 1,
                    cursor: first.nextCursor!,
                    filters: {
                        focus: 'MEANINGFUL',
                        themes: ['quiet-move', 'defense'],
                    },
                },
            })
        ).resolves.toEqual({
            items: [],
            nextCursor: null,
            appliedFilters: {
                focus: 'MEANINGFUL',
                themes: ['quiet-move', 'defense'],
            },
        });

        await expect(
            listTrainingSession({
                db: db as never,
                userId: 'user-1',
                request: {
                    limit: 1,
                    cursor: first.nextCursor!,
                    filters: {
                        focus: 'MAJOR',
                        themes: ['quiet-move', 'defense'],
                    },
                },
            })
        ).rejects.toBeInstanceOf(InvalidTrainingCursorError);
        expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('parses repeated filters and rejects loose booleans or oversized limits', () => {
        const parsed = parseTrainingSessionRequest(
            new URL(
                'http://localhost/api/training/session?focus=meaningful&phase=opening&phase=endgame&sourceKind=my_mistake&theme=quiet-move&includeAttempted=false'
            )
        );
        expect(parsed).toEqual({
            limit: 10,
            filters: {
                focus: 'MEANINGFUL',
                phases: ['OPENING', 'ENDGAME'],
                sourceKinds: ['MY_MISTAKE'],
                themes: ['quiet-move'],
                includeAttempted: false,
            },
        });
        expect(
            parseTrainingSessionRequest(
                new URL(
                    'http://localhost/api/training/session?includeAttempted=1'
                )
            )
        ).toBeNull();
        expect(
            parseTrainingSessionRequest(
                new URL(
                    'http://localhost/api/training/session?focus=major&focus=meaningful'
                )
            )
        ).toBeNull();
        expect(
            parseTrainingSessionRequest(
                new URL(
                    'http://localhost/api/training/session?focus=extreme'
                )
            )
        ).toBeNull();
        expect(
            parseTrainingSessionRequest(
                new URL(
                    'http://localhost/api/training/session?limit=51'
                )
            )
        ).toBeNull();
    });

    it('requires a solution revision for START and pins STEP to an attempt', () => {
        expect(
            parseSubmitTrainingAttemptRequest({
                kind: 'START',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                moveUci: 'E2E4',
            })
        ).toBeNull();
        expect(
            parseSubmitTrainingAttemptRequest({
                kind: 'STEP',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                attemptId:
                    '44444444-4444-4444-8444-444444444444',
                stepIndex: 2,
                moveUci: 'G1F3',
            })
        ).toEqual({
            kind: 'STEP',
            clientAttemptId:
                '33333333-3333-4333-8333-333333333333',
            attemptId: '44444444-4444-4444-8444-444444444444',
            stepIndex: 2,
            moveUci: 'g1f3',
        });
        expect(
            parseSubmitTrainingAttemptRequest({
                kind: 'START',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                solutionRevisionId:
                    '22222222-2222-4222-8222-222222222222',
                moveUci: 'e2e4',
                timeSpentMs: 12.5,
            })
        ).toBeNull();
        expect(
            parseSubmitTrainingAttemptRequest({
                kind: 'START',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                solutionRevisionId:
                    '22222222-2222-4222-8222-222222222222',
                moveUci: 'e2e4',
                timeSpentMs: 12,
            })
        ).toMatchObject({ timeSpentMs: 12 });
        expect(
            parseSubmitTrainingAttemptRequest({
                kind: 'RETRY',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                attemptId:
                    '44444444-4444-4444-8444-444444444444',
                stepIndex: 2,
                retryId:
                    '55555555-5555-4555-8555-555555555555',
            })
        ).toEqual({
            kind: 'RETRY',
            clientAttemptId:
                '33333333-3333-4333-8333-333333333333',
            attemptId:
                '44444444-4444-4444-8444-444444444444',
            stepIndex: 2,
            retryId:
                '55555555-5555-4555-8555-555555555555',
        });
    });
});
