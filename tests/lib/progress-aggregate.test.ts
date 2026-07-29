import { describe, expect, it } from 'vitest';
import {
    aggregateProgressSnapshot,
    type ProgressAttemptRecord,
    type ProgressGameRecord,
    type ProgressPositionRecord,
} from '@/lib/progress/aggregate';

const AS_OF = new Date('2026-07-30T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number) {
    return new Date(AS_OF.getTime() - days * DAY_MS);
}

function game(
    overrides: Partial<ProgressGameRecord> = {}
): ProgressGameRecord {
    return {
        id: 'game-1',
        provider: 'LICHESS',
        timeClass: 'RAPID',
        sourcePgnHash: 'source-hash',
        playedAt: daysAgo(5),
        analyzedAt: daysAgo(4),
        currentAnalysisRunId: 'run-1',
        currentAnalysisValid: true,
        currentAnalysisRun: {
            id: 'run-1',
            status: 'SUCCEEDED',
            inputPgnHash: 'source-hash',
            configHash: 'config-1',
        },
        analysisJob: null,
        ...overrides,
    };
}

function attempt(args: {
    id: string;
    daysAgo: number;
    status?: ProgressAttemptRecord['status'];
    grade?: ProgressAttemptRecord['grade'];
    rootGrade?: ProgressAttemptRecord['grade'];
    rootMove?: string;
    solutionHash?: string;
    configHash?: string;
    context?: Pick<
        ProgressAttemptRecord,
        | 'contextPhase'
        | 'contextCpLoss'
        | 'contextWinChanceLoss'
        | 'contextSourceKinds'
        | 'contextProvider'
        | 'contextTimeClass'
        | 'contextConfigHash'
        | 'contextSolutionHash'
    >;
}): ProgressAttemptRecord {
    const status = args.status ?? 'GRADED';
    return {
        id: args.id,
        trainingMomentId: 'unassigned-position',
        solutionRevisionId: `revision-${args.solutionHash ?? 'one'}`,
        attemptedAt: daysAgo(args.daysAgo),
        completedAt: daysAgo(args.daysAgo),
        userMoveUci: args.rootMove ?? 'e2e4',
        status,
        grade: args.grade ?? null,
        contextPhase:
            args.context
                ? args.context.contextPhase
                : 'MIDDLEGAME',
        contextCpLoss:
            args.context ? args.context.contextCpLoss : 120,
        contextWinChanceLoss:
            args.context
                ? args.context.contextWinChanceLoss
                : 0.09,
        contextSourceKinds:
            args.context?.contextSourceKinds ?? ['MY_MISTAKE'],
        contextProvider:
            args.context?.contextProvider ?? 'LICHESS',
        contextTimeClass:
            args.context?.contextTimeClass ?? 'RAPID',
        contextConfigHash:
            args.context?.contextConfigHash ??
            args.configHash ??
            'config-1',
        contextSolutionHash:
            args.context?.contextSolutionHash ??
            args.solutionHash ??
            'solution-one',
        steps:
            status === 'GRADED'
                ? [
                      {
                          stepIndex: 0,
                          actor: 'USER',
                          moveUci: args.rootMove ?? 'e2e4',
                          grade: args.rootGrade ?? args.grade ?? null,
                      },
                  ]
                : [],
    };
}

type TestPositionRecord = ProgressPositionRecord & {
    attempts: ProgressAttemptRecord[];
};

function position(
    id: string,
    attempts: ProgressAttemptRecord[] = [],
    overrides: Partial<ProgressPositionRecord> = {}
): TestPositionRecord {
    for (const attempt of attempts) {
        attempt.trainingMomentId = id;
    }
    return {
        id,
        gameId: 'game-1',
        sourcePgnHash: 'source-hash',
        originalMoveUci: 'e2e4',
        cpLoss: 120,
        winChanceLoss: 0.09,
        phase: 'MIDDLEGAME',
        status: 'ACTIVE',
        sourceKinds: ['MY_MISTAKE'],
        currentSolutionRevisionId: 'revision-current',
        archivedAt: null,
        currentSolutionRevision: {
            id: 'revision-current',
            solutionHash: 'solution-one',
            configHash: 'config-1',
            verificationStatus: 'VERIFIED',
            trainable: true,
        },
        observations: [
            {
                analysisRunId: 'run-1',
                solutionRevisionId: 'revision-current',
                observedSolutionHash: 'solution-one',
            },
        ],
        attempts,
        ...overrides,
    };
}

function snapshot(args: {
    games?: ProgressGameRecord[];
    positions?: TestPositionRecord[];
    attempts?: ProgressAttemptRecord[];
    scope?: 28 | 90 | 'all';
    filters?: {
        providers: Array<'LICHESS' | 'CHESSCOM'>;
        timeClasses: Array<
            'BULLET' | 'BLITZ' | 'RAPID' | 'CLASSICAL' | 'UNKNOWN'
        >;
    };
}) {
    const positions = args.positions ?? [];
    return aggregateProgressSnapshot({
        request: {
            scope: args.scope ?? 90,
            asOf: AS_OF,
            filters: args.filters ?? {
                providers: [],
                timeClasses: [],
            },
        },
        user: {
            lichessUsername: 'player',
            chesscomUsername: null,
            serverCreditsBalance: 10,
        },
        games: args.games ?? [game()],
        positions,
        attempts:
            args.attempts ??
            positions.flatMap((position) => position.attempts),
    });
}

describe('aggregateProgressSnapshot', () => {
    it('uses strict current-run source hashes for analysis and Position eligibility', () => {
        const staleGame = game({
            sourcePgnHash: 'new-source-hash',
        });

        const result = snapshot({
            games: [staleGame],
            positions: [position('position-1')],
        });

        expect(result.coverage.analysisStates).toMatchObject({
            imported: 1,
            analyzed: 0,
            stale: 1,
        });
        expect(result.coverage.eligiblePositions).toBe(0);
        expect(result.inventory.eligiblePositions).toBe(0);
    });

    it('reports mutually exclusive imported analysis states', () => {
        const result = snapshot({
            games: [
                game({ id: 'analyzed' }),
                game({
                    id: 'stale',
                    sourcePgnHash: 'changed',
                }),
                game({
                    id: 'queued',
                    analyzedAt: null,
                    currentAnalysisRunId: 'queued-run',
                    currentAnalysisRun: {
                        id: 'queued-run',
                        status: 'QUEUED',
                        inputPgnHash: 'source-hash',
                        configHash: 'config-1',
                    },
                    analysisJob: {
                        status: 'QUEUED',
                        queuedReason: null,
                    },
                }),
                game({
                    id: 'running',
                    analyzedAt: null,
                    currentAnalysisRunId: 'running-run',
                    currentAnalysisRun: {
                        id: 'running-run',
                        status: 'RUNNING',
                        inputPgnHash: 'source-hash',
                        configHash: 'config-1',
                    },
                    analysisJob: {
                        status: 'RUNNING',
                        queuedReason: null,
                    },
                }),
                game({
                    id: 'failed',
                    analyzedAt: null,
                    currentAnalysisRunId: 'failed-run',
                    currentAnalysisRun: {
                        id: 'failed-run',
                        status: 'FAILED',
                        inputPgnHash: 'source-hash',
                        configHash: 'config-1',
                    },
                    analysisJob: {
                        status: 'FAILED',
                        queuedReason: null,
                    },
                }),
                game({
                    id: 'waiting',
                    analyzedAt: null,
                    currentAnalysisRunId: null,
                    currentAnalysisRun: null,
                    analysisJob: null,
                }),
            ],
        });

        expect(result.coverage.analysisStates).toEqual({
            imported: 6,
            analyzed: 1,
            stale: 1,
            queued: 1,
            running: 1,
            failed: 1,
            waiting: 1,
        });
        const states = result.coverage.analysisStates;
        expect(
            states.analyzed +
                states.stale +
                states.queued +
                states.running +
                states.failed +
                states.waiting
        ).toBe(states.imported);
    });

    it('excludes revealed and unresolved attempts and scores a conditional root independently', () => {
        const result = snapshot({
            positions: [
                position('position-1', [
                    attempt({
                        id: 'conditional',
                        daysAgo: 4,
                        grade: 'DIFFERENT_MISTAKE',
                        rootGrade: 'BEST',
                    }),
                    attempt({
                        id: 'reveal',
                        daysAgo: 3,
                        status: 'REVEALED',
                    }),
                    attempt({
                        id: 'unresolved',
                        daysAgo: 2,
                        status: 'UNRESOLVED',
                    }),
                ]),
            ],
        });

        expect(result.practice.gradedAttempts).toBe(1);
        expect(result.practice.revealedAttempts).toBe(1);
        expect(result.practice.unresolvedExcluded).toBe(1);
        expect(result.practice.fullPositionSolve).toMatchObject({
            x: 0,
            n: 1,
            rate: null,
        });
        expect(result.practice.rootDecisionSuccess).toMatchObject({
            x: 1,
            n: 1,
            rate: null,
        });
    });

    it('includes reveals in the first-outcome objective denominator', () => {
        const result = snapshot({
            positions: [
                position('revealed-first', [
                    attempt({
                        id: 'reveal-first',
                        daysAgo: 8,
                        status: 'REVEALED',
                    }),
                    attempt({
                        id: 'solved-later',
                        daysAgo: 3,
                        grade: 'BEST',
                    }),
                ]),
                position('solved-first', [
                    attempt({
                        id: 'best-first',
                        daysAgo: 7,
                        grade: 'GOOD',
                    }),
                ]),
            ],
        });

        expect(result.firstRecordedTerminalOutcome).toMatchObject({
            positions: 2,
            graded: 1,
            revealed: 1,
            metObjective: { x: 1, n: 2 },
            gradedFullSolve: { x: 1, n: 1 },
        });
    });

    it('derives exact repetition from the classified root grade, not move equality', () => {
        const result = snapshot({
            positions: [
                position('position-1', [
                    attempt({
                        id: 'same-move-not-repeat',
                        daysAgo: 5,
                        grade: 'DIFFERENT_MISTAKE',
                        rootGrade: 'DIFFERENT_MISTAKE',
                        rootMove: 'e2e4',
                    }),
                    attempt({
                        id: 'classified-repeat',
                        daysAgo: 3,
                        grade: 'REPEATED_MISTAKE',
                        rootGrade: 'REPEATED_MISTAKE',
                        rootMove: 'd2d4',
                    }),
                ]),
            ],
        });

        expect(
            result.practice.exactOriginalMoveRepeated
        ).toMatchObject({ x: 1, n: 2 });
    });

    it('requires two classified repetitions at least 24 hours apart for persistence', () => {
        const tooClose = snapshot({
            positions: [
                position('position-1', [
                    attempt({
                        id: 'repeat-1',
                        daysAgo: 4,
                        grade: 'REPEATED_MISTAKE',
                        rootGrade: 'REPEATED_MISTAKE',
                    }),
                    attempt({
                        id: 'repeat-2',
                        daysAgo: 3.5,
                        grade: 'REPEATED_MISTAKE',
                        rootGrade: 'REPEATED_MISTAKE',
                    }),
                ]),
            ],
        });
        const persistent = snapshot({
            positions: [
                position('position-1', [
                    attempt({
                        id: 'repeat-1',
                        daysAgo: 4,
                        grade: 'REPEATED_MISTAKE',
                        rootGrade: 'REPEATED_MISTAKE',
                    }),
                    attempt({
                        id: 'repeat-2',
                        daysAgo: 2,
                        grade: 'REPEATED_MISTAKE',
                        rootGrade: 'REPEATED_MISTAKE',
                    }),
                ]),
            ],
        });

        expect(
            tooClose.inventory.persistentOriginalMoveRepetition
        ).toBe(0);
        expect(
            persistent.inventory.persistentOriginalMoveRepetition
        ).toBe(1);
        expect(
            persistent.actions.persistentOriginalMoveRepetition
        ).toHaveLength(1);
    });

    it('anchors delayed rechecks at the first solve and treats the first reveal as observed but unsolved', () => {
        const result = snapshot({
            positions: [
                position('position-1', [
                    attempt({
                        id: 'initial-failure',
                        daysAgo: 25,
                        grade: 'DIFFERENT_MISTAKE',
                    }),
                    attempt({
                        id: 'baseline-solve',
                        daysAgo: 20,
                        grade: 'BEST',
                    }),
                    attempt({
                        id: 'first-recheck-reveal',
                        daysAgo: 10,
                        status: 'REVEALED',
                    }),
                    attempt({
                        id: 'later-recheck-solve',
                        daysAgo: 8,
                        grade: 'GOOD',
                    }),
                ]),
                position('changed-policy', [
                    attempt({
                        id: 'policy-baseline',
                        daysAgo: 20,
                        grade: 'BEST',
                        configHash: 'config-1',
                    }),
                    attempt({
                        id: 'policy-recheck',
                        daysAgo: 10,
                        grade: 'GOOD',
                        configHash: 'config-2',
                    }),
                ]),
            ],
        });

        expect(result.delayedRecheck).toMatchObject({
            eligibleBaselines: 2,
            observedRechecks: 1,
            observationCoverage: { x: 1, n: 2 },
            observedFullSolve: { x: 0, n: 1 },
        });
    });

    it('limits Position/source-game breakdown counts to the selected playedAt window', () => {
        const oldGame = game({
            id: 'old-game',
            playedAt: daysAgo(120),
        });
        const result = snapshot({
            games: [oldGame],
            positions: [
                position(
                    'old-position',
                    [
                        attempt({
                            id: 'recent-attempt',
                            daysAgo: 2,
                            grade: 'BEST',
                        }),
                    ],
                    { gameId: 'old-game' }
                ),
            ],
        });

        expect(result.practice.gradedAttempts).toBe(1);
        expect(result.breakdowns.phase).toEqual([
            expect.objectContaining({
                key: 'MIDDLEGAME',
                positions: 0,
                sourceGames: 0,
                gradedAttempts: 1,
            }),
        ]);
        expect(result.breakdowns.provider).toEqual([
            expect.objectContaining({
                key: 'LICHESS',
                positions: 0,
                sourceGames: 0,
                gradedAttempts: 1,
            }),
        ]);
    });

    it('keeps historical Practice context frozen while current-semantic inventory resets after reanalysis', () => {
        const oldAttempt = attempt({
            id: 'old-semantics',
            daysAgo: 3,
            grade: 'BEST',
            solutionHash: 'solution-old',
            configHash: 'config-old',
            context: {
                contextPhase: 'OPENING',
                contextCpLoss: 200,
                contextWinChanceLoss: null,
                contextSourceKinds: ['MISSED_OPPORTUNITY'],
                contextProvider: 'CHESSCOM',
                contextTimeClass: 'BLITZ',
                contextConfigHash: 'config-old',
                contextSolutionHash: 'solution-old',
            },
        });
        const result = snapshot({
            positions: [
                position('revised-position', [oldAttempt], {
                    phase: 'ENDGAME',
                    currentSolutionRevision: {
                        id: 'revision-current',
                        solutionHash: 'solution-new',
                        configHash: 'config-new',
                        verificationStatus: 'VERIFIED',
                        trainable: true,
                    },
                    observations: [
                        {
                            analysisRunId: 'run-1',
                            solutionRevisionId:
                                'revision-current',
                            observedSolutionHash: 'solution-new',
                        },
                    ],
                }),
            ],
        });

        expect(result.practice.fullPositionSolve).toMatchObject({
            x: 1,
            n: 1,
        });
        expect(result.inventory).toMatchObject({
            fresh: 1,
            needsAnotherLook: 0,
        });
        expect(
            result.comparability.currentConfigDistribution
        ).toEqual([
            {
                key: 'config-old',
                count: 1,
                share: 1,
            },
        ]);
        expect(result.breakdowns.phase).toEqual([
            expect.objectContaining({
                key: 'ENDGAME',
                positions: 1,
                gradedAttempts: 0,
            }),
            expect.objectContaining({
                key: 'OPENING',
                positions: 0,
                gradedAttempts: 1,
            }),
        ]);
        expect(result.breakdowns.provider).toEqual([
            expect.objectContaining({
                key: 'CHESSCOM',
                positions: 0,
                gradedAttempts: 1,
            }),
            expect.objectContaining({
                key: 'LICHESS',
                positions: 1,
                gradedAttempts: 0,
            }),
        ]);
        expect(result.breakdowns.impact).toEqual([
            expect.objectContaining({
                key: 'CENTIPAWN_FALLBACK_MAJOR',
                positions: 0,
                gradedAttempts: 1,
            }),
            expect.objectContaining({
                key: 'WIN_CHANCE_MEANINGFUL',
                positions: 1,
                gradedAttempts: 0,
            }),
        ]);
    });

    it('distinguishes data outside the selected scope from an empty filter result', () => {
        const oldOnly = snapshot({
            scope: 28,
            games: [
                game({
                    playedAt: daysAgo(40),
                }),
            ],
        });
        const filteredEmpty = snapshot({
            games: [game()],
            filters: {
                providers: ['CHESSCOM'],
                timeClasses: [],
            },
        });

        expect(oldOnly.availability).toMatchObject({
            hasDataOutsideScope: true,
            filteredEmpty: false,
        });
        expect(filteredEmpty.availability).toMatchObject({
            hasDataOutsideScope: false,
            filteredEmpty: true,
        });
        expect(filteredEmpty.operational.primaryState).toBe('READY');
    });

    it('never mixes win-chance and centipawn impact buckets', () => {
        const result = snapshot({
            positions: [
                position('win-chance', [], {
                    winChanceLoss: 0.13,
                    cpLoss: 500,
                }),
                position('cp-only', [], {
                    winChanceLoss: null,
                    cpLoss: 160,
                }),
            ],
        });

        expect(result.impact).toMatchObject({
            winningChance: {
                low: 0,
                meaningful: 0,
                major: 1,
            },
            centipawnFallback: {
                low: 0,
                meaningful: 0,
                major: 1,
            },
            unknown: 0,
        });
    });

    it('keeps archived Position attempts in historical Practice while current inventory stays empty', () => {
        const archivedAttempt = attempt({
            id: 'archived-attempt',
            daysAgo: 2,
            grade: 'BEST',
        });
        archivedAttempt.trainingMomentId = 'archived-position';

        const result = snapshot({
            positions: [],
            attempts: [archivedAttempt],
        });

        expect(result.inventory.eligiblePositions).toBe(0);
        expect(result.practice).toMatchObject({
            gradedAttempts: 1,
            fullPositionSolve: { x: 1, n: 1 },
        });
        expect(result.firstRecordedTerminalOutcome).toMatchObject({
            positions: 1,
            graded: 1,
            metObjective: { x: 1, n: 1 },
        });
    });

    it('does not skip a one-day same-semantics follow-up to cherry-pick a later delayed recheck', () => {
        const baseline = attempt({
            id: 'baseline',
            daysAgo: 20,
            grade: 'BEST',
        });
        const earlyFollowUp = attempt({
            id: 'early-follow-up',
            daysAgo: 19,
            grade: 'GOOD',
        });
        const laterFollowUp = attempt({
            id: 'later-follow-up',
            daysAgo: 10,
            grade: 'GOOD',
        });
        for (const item of [
            baseline,
            earlyFollowUp,
            laterFollowUp,
        ]) {
            item.trainingMomentId = 'position-with-early-follow-up';
        }

        const result = snapshot({
            positions: [],
            attempts: [baseline, earlyFollowUp, laterFollowUp],
        });

        expect(result.delayedRecheck).toMatchObject({
            eligibleBaselines: 0,
            observedRechecks: 0,
            observationCoverage: { x: 0, n: 0 },
        });
    });

    it('does not let current game coverage block a comparable frozen-attempt Practice trend', () => {
        const current = Array.from({ length: 50 }, (_, index) =>
            attempt({
                id: `current-${index}`,
                daysAgo: 1 + index / 100,
                grade: 'BEST',
            })
        );
        const previous = Array.from({ length: 50 }, (_, index) =>
            attempt({
                id: `previous-${index}`,
                daysAgo: 29 + index / 100,
                grade: 'BEST',
            })
        );
        for (const [index, item] of [
            ...current,
            ...previous,
        ].entries()) {
            item.trainingMomentId = `trend-position-${index}`;
        }

        const result = snapshot({
            scope: 28,
            positions: [],
            attempts: [...current, ...previous],
            games: [game({ playedAt: daysAgo(2) })],
        });

        expect(result.practice.fullPositionSolveTrend).toMatchObject({
            status: 'SHOWN',
            reason: 'AVAILABLE',
        });
        expect(
            result.guardrails.trend.requiresComparableCoverage
        ).toBe(false);
    });

    it('compares config shares and frozen phase/impact/source/provider/time mix, not config sets', () => {
        const cohort = (
            prefix: string,
            baseDays: number,
            configA: number,
            phase: 'OPENING' | 'MIDDLEGAME'
        ) =>
            Array.from({ length: 50 }, (_, index) => {
                const item = attempt({
                    id: `${prefix}-${index}`,
                    daysAgo: baseDays + index / 100,
                    grade: 'BEST',
                    context: {
                        contextPhase: phase,
                        contextCpLoss: 200,
                        contextWinChanceLoss: null,
                        contextSourceKinds: ['MY_MISTAKE'],
                        contextProvider: 'LICHESS',
                        contextTimeClass: 'RAPID',
                        contextConfigHash:
                            index < configA ? 'config-a' : 'config-b',
                        contextSolutionHash: 'solution-one',
                    },
                });
                item.trainingMomentId = `${prefix}-position-${index}`;
                return item;
            });
        const configShift = snapshot({
            scope: 28,
            positions: [],
            attempts: [
                ...cohort('current', 1, 40, 'OPENING'),
                ...cohort('previous', 29, 10, 'OPENING'),
            ],
        });
        const mixShift = snapshot({
            scope: 28,
            positions: [],
            attempts: [
                ...cohort('current-mix', 1, 25, 'OPENING'),
                ...cohort(
                    'previous-mix',
                    29,
                    25,
                    'MIDDLEGAME'
                ),
            ],
        });
        const providerShift = snapshot({
            scope: 28,
            positions: [],
            attempts: [
                ...cohort('current-provider', 1, 25, 'OPENING'),
                ...cohort(
                    'previous-provider',
                    29,
                    25,
                    'OPENING'
                ).map((item) => ({
                    ...item,
                    contextProvider: 'CHESSCOM' as const,
                })),
            ],
        });

        expect(configShift.comparability).toMatchObject({
            comparableConfig: false,
            currentConfigDistribution: [
                { key: 'config-a', count: 40, share: 0.8 },
                { key: 'config-b', count: 10, share: 0.2 },
            ],
            previousConfigDistribution: [
                { key: 'config-a', count: 10, share: 0.2 },
                { key: 'config-b', count: 40, share: 0.8 },
            ],
        });
        expect(
            configShift.practice.fullPositionSolveTrend.reason
        ).toBe('CONFIG_CHANGED');
        expect(mixShift.comparability).toMatchObject({
            comparableConfig: true,
            comparableMix: false,
        });
        expect(
            mixShift.practice.fullPositionSolveTrend.reason
        ).toBe('MIX_CHANGED');
        expect(providerShift.comparability.comparableMix).toBe(
            false
        );
        expect(
            providerShift.practice.fullPositionSolveTrend.reason
        ).toBe('MIX_CHANGED');
    });

    it('uses all current-semantic history for inventory after source metadata is corrected', () => {
        const historicalAttempt = attempt({
            id: 'before-time-class-correction',
            daysAgo: 3,
            grade: 'BEST',
            context: {
                contextPhase: 'MIDDLEGAME',
                contextCpLoss: 120,
                contextWinChanceLoss: 0.09,
                contextSourceKinds: ['MY_MISTAKE'],
                contextProvider: 'LICHESS',
                contextTimeClass: 'UNKNOWN',
                contextConfigHash: 'config-1',
                contextSolutionHash: 'solution-one',
            },
        });
        const result = snapshot({
            filters: {
                providers: [],
                timeClasses: ['RAPID'],
            },
            positions: [
                position('corrected-position', [
                    historicalAttempt,
                ]),
            ],
        });

        expect(result.practice.gradedAttempts).toBe(0);
        expect(result.inventory).toMatchObject({
            eligiblePositions: 1,
            fresh: 0,
        });
    });

    it('keeps a filter option available when frozen Practice attempts exist without current source games', () => {
        const oldLichessAttempt = attempt({
            id: 'old-lichess-practice',
            daysAgo: 2,
            grade: 'GOOD',
        });
        oldLichessAttempt.trainingMomentId = 'old-lichess-position';
        const result = snapshot({
            positions: [],
            attempts: [oldLichessAttempt],
            games: [
                game({
                    provider: 'CHESSCOM',
                    id: 'current-chesscom-game',
                }),
            ],
            filters: {
                providers: ['LICHESS'],
                timeClasses: [],
            },
        });

        expect(
            result.availability.providers.find(
                (option) => option.key === 'LICHESS'
            )
        ).toEqual({
            key: 'LICHESS',
            sourceGames: 0,
            terminalAttempts: 1,
        });
        expect(result.availability.filteredEmpty).toBe(false);
        expect(result.practice.gradedAttempts).toBe(1);
    });
});
