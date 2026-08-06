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
        solution: {
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
        },
    };
}

describe('personal puzzle finder', () => {
    it('scans newest first and stops before requesting the next game', async () => {
        const calls: string[] = [];
        const extractor = vi.fn(async (args: { games: NormalizedGame[] }) => {
            const id = args.games[0]!.id;
            calls.push(id);
            return {
                moments: id === 'middle' ? [candidate(id)] : [],
                manifests: [],
                configSnapshot: {},
                configHash: 'test',
            };
        });
        const result = await findFirstVerifiedPersonalPuzzle({
            games: [
                game('oldest', '2026-08-01T00:00:00.000Z'),
                game('newest', '2026-08-06T00:00:00.000Z'),
                game('middle', '2026-08-05T00:00:00.000Z'),
            ],
            identity: { provider: 'lichess', username: 'public-player' },
            engine: {} as StockfishEngine,
            extractor: extractor as unknown as Parameters<
                typeof findFirstVerifiedPersonalPuzzle
            >[0]['extractor'],
        });

        expect(calls).toEqual(['newest', 'middle']);
        expect(extractor).toHaveBeenCalledTimes(2);
        expect(result?.context.kind).toBe('PERSONAL');
        expect(result?.context.sourceUrl).toBe('https://lichess.org/middle');
    });
});
