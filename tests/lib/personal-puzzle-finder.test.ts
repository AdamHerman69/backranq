import { fixtureSolution } from '../helpers/extractionEvidence';
import { describe, expect, it, vi } from 'vitest';

import type { StockfishEngine } from '@/lib/analysis/stockfishClient';
import { findFirstVerifiedPersonalPuzzle } from '@/lib/onboarding/personalPuzzleFinder';
import { normalizeGradingPolicy } from '@/lib/training/config';
import type { TrainingMomentCandidate } from '@/lib/training/contracts';
import type { NormalizedGame } from '@/lib/types/game';

const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const after = '5Q1k/8/6K1/8/8/8/8/8 b - - 1 1';

function game(id: string, playedAt: string): NormalizedGame {
    return {
        id,
        provider: 'lichess',
        url: `https://lichess.org/${id}`,
        playedAt,
        timeClass: 'rapid',
        white: { name: 'public-player' },
        black: { name: 'opponent' },
        pgn: '[Result "*"]\n\n*',
        provenance: { username: 'public-player', userSide: 'white' },
    };
}

function candidate(sourceGameId: string): TrainingMomentCandidate {
    return {
        sourceGameId,
        sourceProvider: 'lichess',
        sourcePlayedAt: '2026-08-05T00:00:00.000Z',
        sourcePgnHash: `hash-${sourceGameId}`,
        decisionPly: 0,
        fen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'f7e7',
        originalDecision: {
            scoreBefore: { kind: 'mate', plies: 1, winner: 'WHITE' },
            scoreAfter: { kind: 'cp', cp: 0, pov: 'WHITE' },
        },
        confidence: 1,
        phase: 'ENDGAME',
        sourceKinds: ['MISSED_OPPORTUNITY'],
        lessonKinds: ['CONVERT_ADVANTAGE'],
        themes: ['mate'],
        solution: fixtureSolution({
            verificationStatus: 'VERIFIED',
            solutionShape: 'UNIQUE',
            gradingStrategy: 'PRECOMPUTED',
            continuationShape: 'SINGLE_DECISION',
            trainable: true,
            bestMoveUci: 'f7f8',
            acceptedMovesUci: ['f7f8'],
            acceptanceFrontier: {
                version: 1,
                status: 'STABLE',
                targetCutoffCp: 100,
                effectiveCutoffCp: 0,
                boundaryGapCp: null,
                moves: [{ moveUci: 'f7f8', tier: 'BEST' }],
                firstRejectedMoveUci: null,
            },
            moveAssessments: [
                {
                    positionKey: 'root',
                    decisionIndex: 0,
                    fen,
                    moveUci: 'f7f8',
                    source: 'PRECOMPUTED',
                    grade: 'BEST',
                    scoreAfter: { kind: 'mate', plies: 0, winner: 'WHITE' },
                    evidence: { kind: 'TEST' },
                },
            ],
            bestLineUci: ['f7f8'],
            solutionTree: {
                fen,
                ply: 0,
                role: 'USER',
                acceptedMovesUci: ['f7f8'],
                alternativesComplete: true,
                branches: [
                    {
                        moveUci: 'f7f8',
                        best: true,
                        child: {
                            fen: after,
                            ply: 1,
                            role: 'TERMINAL',
                            acceptedMovesUci: [],
                            alternativesComplete: true,
                            stopReason: 'CHECKMATE',
                            branches: [],
                        },
                    },
                ],
            },
            scoreAtStart: { kind: 'mate', plies: 1, winner: 'WHITE' },
            playedMoveScore: { kind: 'cp', cp: 0, pov: 'WHITE' },
            targetOutcome: { preserve: 'win' },
            gradingPolicy: normalizeGradingPolicy(undefined),
            solutionHash: `solution-${sourceGameId}`,
            evidence: { kind: 'TEST' },
            generatorVersion: 'test',
            configHash: 'test-config',
        }),
    };
}

type ExtractorArgs = Parameters<
    NonNullable<Parameters<typeof findFirstVerifiedPersonalPuzzle>[0]['extractor']>
>[0];

function output(moments: TrainingMomentCandidate[] = []) {
    return { moments, manifests: [], configSnapshot: {}, configHash: 'test' };
}

const identity = { provider: 'lichess', username: 'public-player' } as const;
const engine = {} as StockfishEngine;

describe('personal puzzle finder', () => {
    it('uses one FIRST_PUZZLE invocation for the newest game and never opens older games after success', async () => {
        const extractor = vi.fn(async (args: ExtractorArgs) => {
            expect(args.strategy).toBe('FIRST_PUZZLE');
            expect(args.options).toMatchObject({ nodesPerPosition: 12_000, confirmNodes: 180_000, maxConfirmationNodes: 500_000 });
            return output([candidate(args.games[0]!.id)]);
        });
        const result = await findFirstVerifiedPersonalPuzzle({
            games: [game('old', '2026-08-01'), game('new', '2026-08-06')], identity, engine, extractor,
        });
        expect(extractor).toHaveBeenCalledTimes(1);
        expect(extractor.mock.calls[0]![0].games[0]!.id).toBe('new');
        expect(result?.context.sourceUrl).toBe('https://lichess.org/new');
    });

    it('finishes each game before trying the next oldest, ignoring untrainable results', async () => {
        const calls: string[] = [];
        const extractor = vi.fn(async (args: ExtractorArgs) => {
            const id = args.games[0]!.id; calls.push(id);
            const found = candidate(id);
            found.solution.trainable = id === 'oldest';
            return output(id === 'newest' ? [] : [found]);
        });
        const result = await findFirstVerifiedPersonalPuzzle({
            games: [game('oldest', '2026-08-01'), game('newest', '2026-08-06'), game('middle', '2026-08-05')],
            identity, engine, extractor,
        });
        expect(calls).toEqual(['newest', 'middle', 'oldest']);
        expect(result?.context.sourceUrl).toBe('https://lichess.org/oldest');
    });

    it('only searches games whose immutable provider identity and player side match the requested account', async () => {
        const wrongPlayer = game('wrong-player', '2026-08-01'); wrongPlayer.white.name = 'another-player';
        const wrongProvider = { ...game('wrong-provider', '2026-08-01'), provider: 'chesscom' as const };
        const wrongIdentity = game('wrong-identity', '2026-08-01');
        wrongIdentity.white.name = 'another-player'; wrongIdentity.provenance!.username = 'another-player';
        const black = game('black', '2026-08-01');
        black.black.name = 'public-player'; black.white.name = 'opponent'; black.provenance!.userSide = 'black';
        const extractor = vi.fn(async (args: ExtractorArgs) => { expect(args.strategy).toBe('FIRST_PUZZLE'); return output(); });
        await findFirstVerifiedPersonalPuzzle({ games: [wrongPlayer, wrongProvider, wrongIdentity, black], identity, engine, extractor });
        expect(extractor).toHaveBeenCalledTimes(1);
        expect(extractor.mock.calls[0]![0].games[0]!.id).toBe('black');
    });

    it('maps canonical engine progress without replaying the source PGN', async () => {
        const progress = vi.fn();
        const source = game('source', '2026-08-01');
        source.pgn = 'Deliberately not independently parseable by presentation';
        const extractor = vi.fn(async (args: ExtractorArgs) => {
            for (const phase of ['scanning', 'confirming'] as const) args.onProgress?.({
                runId: 'run-1', gameId: source.id, gameIndex: 0, gameCount: 1,
                ply: 2, plyCount: 4, phase, fen, previousFen: after, positionHistory: [after], userSide: 'white',
            });
            return output();
        });
        await findFirstVerifiedPersonalPuzzle({ games: [source], identity, engine, extractor, onProgress: progress });
        expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(['SCANNING', 'CONFIRMING']);
        expect(progress.mock.calls[1]![0]).toMatchObject({ runId: 'run-1', ply: 2,
            preview: { gameId: 'source', fen, previousFen: after, orientation: 'white' } });
    });

    it('honors cancellation before publishing a late result or progress event', async () => {
        const controller = new AbortController(); const progress = vi.fn();
        const extractor = vi.fn(async (args: ExtractorArgs) => {
            controller.abort();
            args.onProgress?.({ runId: 'late', gameId: 'source', gameIndex: 0, gameCount: 1,
                ply: 0, plyCount: 1, phase: 'confirming', fen, positionHistory: [], userSide: 'white' });
            return output([candidate('source')]);
        });
        await expect(findFirstVerifiedPersonalPuzzle({
            games: [game('source', '2026-08-01')], identity, engine, extractor, signal: controller.signal, onProgress: progress,
        })).rejects.toThrow('Analysis aborted');
        expect(extractor).toHaveBeenCalledTimes(1);
        expect(progress).not.toHaveBeenCalled();
    });
});
