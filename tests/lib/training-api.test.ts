import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTrainingMomentPrompt,
    InvalidPracticeFeedCursorError,
    listPracticeFeed,
} from '@/lib/training/readService';
import {
    parseRecordTrainingAttemptRequest,
    parsePracticeFeedRequest,
} from '@/lib/training/apiValidation';
import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';

vi.mock('@/lib/training/practiceFeedQueries', () => ({
    queryDuePracticeStream: vi.fn(),
    queryNewPracticeStream: vi.fn(),
}));

const queryDueMock = vi.mocked(queryDuePracticeStream);
const queryNewMock = vi.mocked(queryNewPracticeStream);

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
    beforeEach(() => {
        queryDueMock.mockReset().mockResolvedValue([]);
        queryNewMock.mockReset().mockResolvedValue([
            {
                id: promptRow.id,
                currentSolutionRevisionId:
                    promptRow.currentSolutionRevisionId,
                key: {
                    createdAt: promptRow.createdAt.toISOString(),
                    id: promptRow.id,
                },
            },
        ]);
    });
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
                where: expect.objectContaining({
                    currentSolutionRevision: {
                        is: expect.objectContaining({
                            trainable: true,
                            verificationStatus: 'VERIFIED',
                        }),
                    },
                }),
                select: expect.objectContaining({
                    currentSolutionRevision:
                        expect.any(Object),
                }),
            })
        );
    });

    it('refuses to serve a prompt whose accepted set is not complete', async () => {
        const findMany = vi.fn().mockResolvedValue([
            {
                ...promptRow,
                currentSolutionRevision: {
                    ...promptRow.currentSolutionRevision,
                    acceptanceFrontier: {
                        ...promptRow.currentSolutionRevision
                            .acceptanceFrontier,
                        status: 'OPEN',
                        effectiveCutoffCp: null,
                        boundaryGapCp: null,
                    },
                    solutionTree: {
                        ...promptRow.currentSolutionRevision
                            .solutionTree,
                        alternativesComplete: false,
                    },
                },
            },
        ]);

        await expect(
            listPracticeFeed({
                db: { trainingMoment: { findMany } } as never,
                userId: 'user-1',
                request: { limit: 10 },
            })
        ).rejects.toThrow('invalid grading evidence');
    });

    it('interleaves bounded due and new streams without trusting database return order', async () => {
        const ids = {
            due1: '10000000-0000-4000-8000-000000000001',
            due2: '10000000-0000-4000-8000-000000000002',
            due3: '10000000-0000-4000-8000-000000000003',
            fresh1: '10000000-0000-4000-8000-000000000004',
            fresh2: '10000000-0000-4000-8000-000000000005',
        };
        const revisions = Object.fromEntries(
            Object.entries(ids).map(([name], index) => [
                name,
                `20000000-0000-4000-8000-00000000000${index + 1}`,
            ])
        ) as Record<keyof typeof ids, string>;
        const due = (name: 'due1' | 'due2' | 'due3', lapses: number) => ({
            id: ids[name],
            currentSolutionRevisionId: revisions[name],
            key: {
                lapseBucket: 1 as const,
                lapses,
                nextDueAt: '2026-01-01T00:00:00.000Z',
                lastReviewedAt: '2025-12-01T00:00:00.000Z',
                createdAt: '2025-01-01T00:00:00.000Z',
                id: ids[name],
            },
        });
        const fresh = (name: 'fresh1' | 'fresh2') => ({
            id: ids[name],
            currentSolutionRevisionId: revisions[name],
            key: {
                createdAt: '2026-01-01T00:00:00.000Z',
                id: ids[name],
            },
        });
        queryDueMock.mockResolvedValue([
            due('due1', 3),
            due('due2', 2),
            due('due3', 1),
        ]);
        queryNewMock.mockResolvedValue([
            fresh('fresh1'),
            fresh('fresh2'),
        ]);
        const selectedNames = ['fresh1', 'due2', 'due1'] as const;
        const findMany = vi.fn().mockResolvedValue(
            selectedNames.map((name) => ({
                ...promptRow,
                id: ids[name],
                currentSolutionRevisionId: revisions[name],
            }))
        );
        const now = new Date('2026-02-01T00:00:00.000Z');

        const feed = await listPracticeFeed({
            db: { trainingMoment: { findMany } } as never,
            userId: 'user-1',
            request: { limit: 3 },
            now: () => now,
        });

        expect(feed.items.map((item) => item.id)).toEqual([
            ids.due1,
            ids.due2,
            ids.fresh1,
        ]);
        expect(feed.nextCursor).toEqual(expect.any(String));
        expect(queryDueMock).toHaveBeenCalledWith(
            expect.objectContaining({ take: 4, feedStartedAt: now })
        );
        expect(queryNewMock).toHaveBeenCalledWith(
            expect.objectContaining({ take: 4, feedStartedAt: now })
        );
    });

    it.each(['MEANINGFUL', 'MAJOR'] as const)(
        'passes %s focus to both authoritative SQL streams',
        async (focus) => {
            queryNewMock.mockResolvedValue([]);
            await listPracticeFeed({
                db: {
                    trainingMoment: { findMany: vi.fn() },
                } as never,
                userId: 'user-1',
                request: {
                    limit: 10,
                    filters: { focus },
                },
            });

            expect(queryDueMock).toHaveBeenCalledWith(
                expect.objectContaining({ filters: { focus } })
            );
            expect(queryNewMock).toHaveBeenCalledWith(
                expect.objectContaining({ filters: { focus } })
            );
        }
    );

    it('keeps one feed snapshot and resumes each stream from its own key', async () => {
        const secondId = '11111111-1111-4111-8111-111111111112';
        const secondRevision =
            '22222222-2222-4222-8222-222222222223';
        const firstKey = {
            lapseBucket: 1 as const,
            lapses: 2,
            nextDueAt: '2026-01-01T00:00:00.000Z',
            lastReviewedAt: '2025-12-01T00:00:00.000Z',
            createdAt: promptRow.createdAt.toISOString(),
            id: promptRow.id,
        };
        queryNewMock.mockResolvedValue([]);
        queryDueMock
            .mockResolvedValueOnce([
                {
                    id: promptRow.id,
                    currentSolutionRevisionId:
                        promptRow.currentSolutionRevisionId,
                    key: firstKey,
                },
                {
                    id: secondId,
                    currentSolutionRevisionId: secondRevision,
                    key: { ...firstKey, lapses: 1, id: secondId },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: secondId,
                    currentSolutionRevisionId: secondRevision,
                    key: { ...firstKey, lapses: 1, id: secondId },
                },
            ]);
        const findMany = vi
            .fn()
            .mockResolvedValueOnce([promptRow])
            .mockResolvedValueOnce([
                {
                    ...promptRow,
                    id: secondId,
                    currentSolutionRevisionId: secondRevision,
                },
            ]);
        const startedAt = new Date('2026-02-01T00:00:00.000Z');

        const first = await listPracticeFeed({
            db: { trainingMoment: { findMany } } as never,
            userId: 'user-1',
            request: { limit: 1 },
            now: () => startedAt,
        });
        const second = await listPracticeFeed({
            db: { trainingMoment: { findMany } } as never,
            userId: 'user-1',
            request: { limit: 1, cursor: first.nextCursor! },
            now: () => new Date('2026-02-02T00:00:00.000Z'),
        });

        expect(first.items.map((item) => item.id)).toEqual([promptRow.id]);
        expect(second.items.map((item) => item.id)).toEqual([secondId]);
        expect(queryDueMock.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
                feedStartedAt: startedAt,
                cursor: firstKey,
            })
        );
    });

    it('rejects a cursor that forges a future feed snapshot', async () => {
        const nextId = '11111111-1111-4111-8111-111111111112';
        queryNewMock.mockResolvedValue([
            {
                id: promptRow.id,
                currentSolutionRevisionId:
                    promptRow.currentSolutionRevisionId,
                key: {
                    createdAt: promptRow.createdAt.toISOString(),
                    id: promptRow.id,
                },
            },
            {
                id: nextId,
                currentSolutionRevisionId:
                    '22222222-2222-4222-8222-222222222223',
                key: {
                    createdAt: '2026-01-01T00:01:00.000Z',
                    id: nextId,
                },
            },
        ]);
        const findMany = vi.fn().mockResolvedValue([promptRow]);
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
        const nextId = '11111111-1111-4111-8111-111111111112';
        queryNewMock
            .mockResolvedValueOnce([
                {
                    id: promptRow.id,
                    currentSolutionRevisionId:
                        promptRow.currentSolutionRevisionId,
                    key: {
                        createdAt: promptRow.createdAt.toISOString(),
                        id: promptRow.id,
                    },
                },
                {
                    id: nextId,
                    currentSolutionRevisionId:
                        '22222222-2222-4222-8222-222222222223',
                    key: {
                        createdAt: '2026-01-01T00:01:00.000Z',
                        id: nextId,
                    },
                },
            ])
            .mockResolvedValueOnce([]);
        const findMany = vi
            .fn()
            .mockResolvedValueOnce([promptRow]);
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
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('parses repeated filters and rejects unknown queue modes or oversized limits', () => {
        const parsed = parsePracticeFeedRequest(
            new URL(
                'http://localhost/api/training/feed?focus=meaningful&phase=opening&phase=endgame&sourceKind=my_mistake&theme=quiet-move&mode=new'
            )
        );
        expect(parsed).toEqual({
            limit: 10,
            filters: {
                focus: 'MEANINGFUL',
                phases: ['OPENING', 'ENDGAME'],
                sourceKinds: ['MY_MISTAKE'],
                themes: ['quiet-move'],
                mode: 'NEW',
            },
        });
        expect(
            parsePracticeFeedRequest(
                new URL(
                    'http://localhost/api/training/feed?mode=everything'
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
