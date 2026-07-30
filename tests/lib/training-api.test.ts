import { describe, expect, it, vi } from 'vitest';
import {
    getTrainingMomentPrompt,
    InvalidPracticeFeedCursorError,
    listPracticeFeed,
} from '@/lib/training/readService';
import {
    parseRecordTrainingAttemptRequest,
    parsePracticeFeedRequest,
} from '@/lib/training/apiValidation';

const promptRow = {
    id: '11111111-1111-4111-8111-111111111111',
    currentSolutionRevisionId:
        '22222222-2222-4222-8222-222222222222',
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
        solutionShape: 'OPEN',
        bestLine: ['e2e3'],
        scoreAtStart: { kind: 'cp', cp: 80, pov: 'WHITE' },
        gradingPolicy: {
            version: 2,
            pov: 'TRAINING_SIDE',
            best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
            success: {
                maxCpLoss: 80,
                maxWinChanceLoss: 0.08,
                preserveOutcome: true,
            },
            improvement: {
                minRecoveredCp: 40,
                minRecoveredWinChance: 0.05,
            },
            unknownMove: 'DYNAMIC',
            matePolicy: 'EXACT',
            tablebasePolicy: 'EXACT',
        },
        solutionTree: {
            fen: '8/8/8/8/8/8/4K3/6k1 w - - 0 1',
            ply: 0,
            role: 'USER',
            acceptedMovesUci: ['e2e3'],
            branches: [
                {
                    moveUci: 'e2e3',
                    best: true,
                    child: {
                        fen: '8/8/8/8/8/4K3/8/6k1 b - - 1 1',
                        ply: 1,
                        role: 'TERMINAL',
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
                evidence: {
                    bestGapCp: 0,
                    preservesOutcome: true,
                },
            },
        ],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastTrainedAt: null,
};

describe('canonical training API boundary', () => {
    it('returns the complete local grading manifest with each prompt', async () => {
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

        const feed = await listPracticeFeed({
            db: db as never,
            userId: 'user-1',
            request: { limit: 10 },
        });
        const detail = await getTrainingMomentPrompt({
            db: db as never,
            userId: 'user-1',
            momentId: promptRow.id,
        });

        const expected = expect.objectContaining({
            id: promptRow.id,
            solutionRevisionId:
                promptRow.currentSolutionRevisionId,
            fen: promptRow.fen,
            sideToMove: 'w',
            grading: expect.objectContaining({
                originalMoveUci: 'e2f2',
                moveAssessments: [
                    expect.objectContaining({
                        moveUci: 'e2e3',
                        grade: 'BEST',
                    }),
                ],
            }),
        });
        expect(feed).toEqual({
            items: [expected],
            nextCursor: null,
            appliedFilters: {},
        });
        expect(detail).toEqual({ moment: expected });
        expect(feed.items[0]?.grading.review.bestMoveUci).toBe(
            'e2e3'
        );
        expect(db.trainingMoment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    currentSolutionRevision:
                        expect.any(Object),
                }),
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

        const feed = await listPracticeFeed({
            db: db as never,
            userId: 'user-1',
            request: { limit: 10 },
        });

        expect(feed.items).toHaveLength(1);
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
            await listPracticeFeed({
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

    it('uses a stable feed snapshot so mutable review timestamps cannot repeat pages', async () => {
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
            const page = await listPracticeFeed({
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

    it('rejects a cursor that forges a future feed snapshot', async () => {
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
        const first = await listPracticeFeed({
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
                feedStartedAt: '2999-01-01T00:00:00.000Z',
            }),
            'utf8'
        ).toString('base64url');

        await expect(
            listPracticeFeed({
                db: db as never,
                userId: 'user-1',
                request: { limit: 5, cursor },
            })
        ).rejects.toBeInstanceOf(InvalidPracticeFeedCursorError);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('binds a feed cursor to its normalized filters', async () => {
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
        const first = await listPracticeFeed({
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
            listPracticeFeed({
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
            listPracticeFeed({
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
        ).rejects.toBeInstanceOf(InvalidPracticeFeedCursorError);
        expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('parses repeated filters and rejects loose booleans or oversized limits', () => {
        const parsed = parsePracticeFeedRequest(
            new URL(
                'http://localhost/api/training/feed?focus=meaningful&phase=opening&phase=endgame&sourceKind=my_mistake&theme=quiet-move&includeAttempted=false'
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
            parsePracticeFeedRequest(
                new URL(
                    'http://localhost/api/training/feed?includeAttempted=1'
                )
            )
        ).toBeNull();
        expect(
            parsePracticeFeedRequest(
                new URL(
                    'http://localhost/api/training/feed?focus=major&focus=meaningful'
                )
            )
        ).toBeNull();
        expect(
            parsePracticeFeedRequest(
                new URL(
                    'http://localhost/api/training/feed?focus=extreme'
                )
            )
        ).toBeNull();
        expect(
            parsePracticeFeedRequest(
                new URL(
                    'http://localhost/api/training/feed?limit=51'
                )
            )
        ).toBeNull();
    });

    it('parses only bounded record-only history payloads', () => {
        expect(
            parseRecordTrainingAttemptRequest({
                kind: 'START',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                moveUci: 'E2E4',
            })
        ).toBeNull();
        expect(
            parseRecordTrainingAttemptRequest({
                kind: 'RECORD',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                solutionRevisionId:
                    '22222222-2222-4222-8222-222222222222',
                status: 'GRADED',
                grade: 'BEST',
                gradingSource: 'PRECOMPUTED',
                comparison: null,
                steps: [
                    {
                        stepIndex: 0,
                        actor: 'USER',
                        fenBefore: promptRow.fen,
                        moveUci: 'E2E3',
                        grade: 'BEST',
                        source: 'PRECOMPUTED',
                        timeSpentMs: 12,
                    },
                ],
            })
        ).toEqual({
            kind: 'RECORD',
            clientAttemptId:
                '33333333-3333-4333-8333-333333333333',
            solutionRevisionId:
                '22222222-2222-4222-8222-222222222222',
            status: 'GRADED',
            grade: 'BEST',
            gradingSource: 'PRECOMPUTED',
            comparison: null,
            steps: [
                {
                    stepIndex: 0,
                    actor: 'USER',
                    fenBefore: promptRow.fen,
                    moveUci: 'e2e3',
                    grade: 'BEST',
                    source: 'PRECOMPUTED',
                    timeSpentMs: 12,
                },
            ],
        });
        expect(
            parseRecordTrainingAttemptRequest({
                kind: 'RECORD',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                solutionRevisionId:
                    '22222222-2222-4222-8222-222222222222',
                status: 'GRADED',
                grade: 'BEST',
                steps: [
                    {
                        stepIndex: 0,
                        actor: 'USER',
                        fenBefore: promptRow.fen,
                        moveUci: 'e2e3',
                        grade: 'BEST',
                        timeSpentMs: 12.5,
                    },
                ],
            })
        ).toBeNull();
        expect(
            parseRecordTrainingAttemptRequest({
                kind: 'RECORD',
                clientAttemptId:
                    '33333333-3333-4333-8333-333333333333',
                solutionRevisionId:
                    '22222222-2222-4222-8222-222222222222',
                status: 'REVEALED',
                steps: [],
            })
        ).toEqual({
            kind: 'RECORD',
            clientAttemptId:
                '33333333-3333-4333-8333-333333333333',
            solutionRevisionId:
                '22222222-2222-4222-8222-222222222222',
            status: 'REVEALED',
            steps: [],
        });
    });
});
