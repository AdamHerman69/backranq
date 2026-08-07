import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import corpus from '../fixtures/training-v2/golden-corpus.v2.json';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import type {
    AnalysisLimit,
    EvalResult,
    MultiPvResult,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    trainingMomentKey,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import type { NormalizedGame } from '@/lib/types/game';

type Cost = {
    evalCalls: number;
    multiPvCalls: number;
    requestedNodes: number;
};

function result(
    fen: string,
    bestMoveUci: string,
    score: { type: 'cp' | 'mate'; value: number },
    pvUci: string[]
): EvalResult {
    return { fen, bestMoveUci, score, pvUci };
}

function multi(
    fen: string,
    lines: Array<{
        moveUci: string;
        score: { type: 'cp' | 'mate'; value: number };
        pvUci: string[];
    }>
): MultiPvResult {
    return {
        fen,
        bestMoveUci: lines[0]?.moveUci ?? '',
        alternativesComplete: true,
        lines: lines.map((line, index) => ({
            multipv: index + 1,
            pvUci: line.pvUci,
            score: line.score,
        })),
    };
}

function firstLegalEvaluation(fen: string): EvalResult {
    const move = new Chess(fen).moves({ verbose: true })[0];
    return result(
        fen,
        move?.lan ?? '',
        { type: 'cp', value: 0 },
        move ? [move.lan] : []
    );
}

function after(fen: string, moveUci: string): string {
    const chess = new Chess(fen);
    chess.move({
        from: moveUci.slice(0, 2),
        to: moveUci.slice(2, 4),
        promotion: moveUci.slice(4, 5) || undefined,
    });
    return chess.fen();
}

function fixtureEngine(caseId: string): StockfishEngine {
    if (caseId === 'golden-quiet') {
        const root = new Chess().fen();
        return {
            evalPosition: async ({ fen }) =>
                fen === root
                    ? result(
                          fen,
                          'e2e3',
                          { type: 'cp', value: 100 },
                          ['e2e3', 'e7e5']
                      )
                    : result(
                          fen,
                          'e7e5',
                          { type: 'cp', value: 200 },
                          ['e7e5', 'g1f3']
                      ),
            analyzeMultiPv: async ({ fen }) =>
                multi(fen, [
                    {
                        moveUci: 'e2e3',
                        score: { type: 'cp', value: 100 },
                        pvUci: ['e2e3', 'e7e5'],
                    },
                    {
                        moveUci: 'd2d3',
                        score: { type: 'cp', value: 95 },
                        pvUci: ['d2d3', 'd7d5'],
                    },
                ]),
        };
    }
    if (caseId === 'golden-mate') {
        const root =
            '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
        return {
            evalPosition: async ({ fen }) =>
                fen === root
                    ? result(
                          fen,
                          'f7f8',
                          { type: 'mate', value: 1 },
                          ['f7f8']
                      )
                    : result(
                          fen,
                          'h8g8',
                          { type: 'cp', value: 0 },
                          ['h8g8']
                      ),
            analyzeMultiPv: async ({ fen }) =>
                multi(fen, [
                    {
                        moveUci: 'f7f8',
                        score: { type: 'mate', value: 1 },
                        pvUci: ['f7f8'],
                    },
                ]),
        };
    }
    if (caseId === 'golden-repetition') {
        const root =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const played = after(root, 'e7e6');
        return {
            evalPosition: async ({ fen }) => {
                if (fen === root) {
                    return result(
                        fen,
                        'e7e5',
                        { type: 'cp', value: -300 },
                        ['e7e5', 'g1f3']
                    );
                }
                if (fen === played) {
                    return result(
                        fen,
                        'g1f3',
                        { type: 'cp', value: 400 },
                        ['g1f3', 'b8c6']
                    );
                }
                return firstLegalEvaluation(fen);
            },
            analyzeMultiPv: async ({ fen }) =>
                multi(fen, [
                    {
                        moveUci: 'e7e5',
                        score: { type: 'cp', value: -300 },
                        pvUci: ['e7e5', 'g1f3'],
                    },
                ]),
        };
    }
    if (caseId === 'golden-en-passant') {
        const root =
            'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
        const played = after(root, 'g1f3');
        return {
            evalPosition: async ({ fen }) =>
                fen === root
                    ? result(
                          fen,
                          'e5d6',
                          { type: 'cp', value: 200 },
                          ['e5d6', 'c7d6']
                      )
                    : fen === played
                      ? result(
                            fen,
                            'c7c5',
                            { type: 'cp', value: 200 },
                            ['c7c5', 'd2d4']
                        )
                      : firstLegalEvaluation(fen),
            analyzeMultiPv: async ({ fen }) =>
                multi(fen, [
                    {
                        moveUci: 'e5d6',
                        score: { type: 'cp', value: 200 },
                        pvUci: ['e5d6', 'c7d6'],
                    },
                ]),
        };
    }
    if (caseId === 'golden-no-error') {
        const root = new Chess().fen();
        return {
            evalPosition: async ({ fen }) =>
                fen === root
                    ? result(
                          fen,
                          'e2e4',
                          { type: 'cp', value: 0 },
                          ['e2e4', 'e7e5']
                      )
                    : result(
                          fen,
                          'e7e5',
                          { type: 'cp', value: 0 },
                          ['e7e5', 'g1f3']
                      ),
            analyzeMultiPv: async ({ fen }) =>
                multi(fen, []),
        };
    }
    throw new Error(`Unknown golden case ${caseId}`);
}

class CountingEngine implements StockfishEngine {
    readonly cost: Cost = {
        evalCalls: 0,
        multiPvCalls: 0,
        requestedNodes: 0,
    };

    constructor(private readonly delegate: StockfishEngine) {}

    evalPosition(
        options: AnalysisLimit & { fen: string }
    ): Promise<EvalResult> {
        this.cost.evalCalls += 1;
        this.cost.requestedNodes += options.nodes ?? 0;
        return this.delegate.evalPosition(options);
    }

    analyzeMultiPv(
        options: AnalysisLimit & {
            fen: string;
            multiPv?: number;
        }
    ): Promise<MultiPvResult> {
        this.cost.multiPvCalls += 1;
        this.cost.requestedNodes += options.nodes ?? 0;
        return this.delegate.analyzeMultiPv(options);
    }
}

type Snapshot = {
    id: string;
    sourcePgnHash: string;
    trainingMomentKey: string;
    decisionPly: number;
    sourceKinds: string[];
    lessonKinds: string[];
    solutionShape: string;
    bestMoveUci: string;
    solutionHash: string;
};

async function runCorpus(): Promise<{
    snapshots: Snapshot[];
    cost: Cost;
}> {
    const snapshots: Snapshot[] = [];
    const cost: Cost = {
        evalCalls: 0,
        multiPvCalls: 0,
        requestedNodes: 0,
    };
    for (const fixture of corpus.extractionCases) {
        const engine = new CountingEngine(
            fixtureEngine(fixture.id)
        );
        const normalizedGame: NormalizedGame = {
            id: fixture.id,
            provider: 'lichess',
            playedAt: '2026-01-01T00:00:00.000Z',
            timeClass: 'rapid',
            white: {
                name:
                    fixture.usernameColor === 'white'
                        ? 'adam'
                        : 'opponent',
            },
            black: {
                name:
                    fixture.usernameColor === 'black'
                        ? 'adam'
                        : 'opponent',
            },
            pgn: fixture.pgn,
            provenance: {
                username: 'adam',
                userSide:
                    fixture.usernameColor === 'black' ? 'black' : 'white',
            },
        };
        const output = await extractTrainingMomentsFromGames({
            games: [normalizedGame],
            selectedGameIds: new Set([fixture.id]),
            engine,
            options: {
                nodesPerPosition: 100,
                confirmNodes:
                    fixture.id === 'golden-repetition'
                        ? 500
                        : null,
                verifyContinuations: false,
            },
        });
        expect(output.manifests).toMatchObject([
            { complete: true, errors: [] },
        ]);
        expect(output.moments).toHaveLength(
            fixture.expectedMoments.length
        );
        const sourcePgnHash = hashSourcePgn(fixture.pgn);
        for (const moment of output.moments as TrainingMomentCandidate[]) {
            snapshots.push({
                id: fixture.id,
                sourcePgnHash,
                trainingMomentKey: trainingMomentKey({
                    gameId: moment.sourceGameId,
                    sourcePgnHash,
                    decisionPly: moment.decisionPly,
                }),
                decisionPly: moment.decisionPly,
                sourceKinds: moment.sourceKinds,
                lessonKinds: moment.lessonKinds,
                solutionShape: moment.solution.solutionShape,
                bestMoveUci: moment.solution.bestMoveUci,
                solutionHash: moment.solution.solutionHash,
            });
        }
        if (fixture.coverage.includes('en-passant')) {
            expect(output.moments[0]).toMatchObject({
                solution: { bestMoveUci: 'e5d6' },
                themes: expect.arrayContaining(['capture']),
            });
        }
        cost.evalCalls += engine.cost.evalCalls;
        cost.multiPvCalls += engine.cost.multiPvCalls;
        cost.requestedNodes += engine.cost.requestedNodes;
    }
    return { snapshots, cost };
}

describe('versioned training V2 golden corpus', () => {
    it('keeps coverage links executable and the PGN corpus stable within its cost budget', async () => {
        expect(corpus.version).toBe(2);
        const coverage = new Set([
            ...corpus.extractionCases.flatMap(
                (fixture) => fixture.coverage
            ),
            ...corpus.linkedAssertions.map(
                (link) => link.coverage
            ),
        ]);
        expect(Array.from(coverage).sort()).toEqual(
            [
                'en-passant',
                'equivalent-alternatives',
                'mate',
                'negative-no-error',
                'quiet-defense',
                'repetition-save',
                'sacrifice',
                'stalemate',
                'tablebase',
                'underpromotion',
            ].sort()
        );
        for (const link of corpus.linkedAssertions) {
            const source = readFileSync(
                resolve(process.cwd(), link.file),
                'utf8'
            );
            expect(source, `${link.coverage} corpus link`).toContain(
                link.testName
            );
        }

        const first = await runCorpus();
        const second = await runCorpus();
        const expected = corpus.extractionCases.flatMap(
            (fixture) =>
                fixture.expectedMoments.map((moment) => ({
                    id: fixture.id,
                    ...moment,
                }))
        );
        expect(
            first.snapshots.map((snapshot) => ({
                id: snapshot.id,
                sourcePgnHash: snapshot.sourcePgnHash,
                trainingMomentKey: snapshot.trainingMomentKey,
                decisionPly: snapshot.decisionPly,
                sourceKinds: snapshot.sourceKinds,
                lessonKinds: snapshot.lessonKinds,
                solutionShape: snapshot.solutionShape,
                bestMoveUci: snapshot.bestMoveUci,
            }))
        ).toEqual(expected);
        expect(second.snapshots).toEqual(first.snapshots);
        expect(second.cost).toEqual(first.cost);
        expect(first.cost.evalCalls).toBeLessThanOrEqual(
            corpus.costBudget.maxEvalCallsPerRun
        );
        expect(first.cost.multiPvCalls).toBeLessThanOrEqual(
            corpus.costBudget.maxMultiPvCallsPerRun
        );
        expect(first.cost.requestedNodes).toBeLessThanOrEqual(
            corpus.costBudget.maxRequestedNodesPerRun
        );
    });
});
