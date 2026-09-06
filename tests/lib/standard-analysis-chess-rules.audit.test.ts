/** Regression checks for defects first reproduced by the 8739124 audit. */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
    acceptanceFrontierFromMultiPv,
    confirmAcceptanceFrontier,
} from '@/lib/training/acceptanceFrontier';
import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    evaluationLoss,
    negateScore,
    winningChance,
} from '@/lib/analysis/evaluation';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { metricsFromPovScores } from '@/lib/training/gradingEvidence';
import type { MultiPvLine } from '@/lib/analysis/stockfishClient';

const policy = normalizeGradingPolicy(undefined);
const lines = (cps: number[]): MultiPvLine[] =>
    cps.map((value, i) => ({
        multipv: i + 1,
        score: { type: 'cp', value },
        pvUci: ['e2e4', 'd2d4', 'g1f3', 'b1c3'][i]
            ? [['e2e4', 'd2d4', 'g1f3', 'b1c3'][i]!]
            : [`a2a${i}`],
    }));

describe('chess audit regressions', () => {
    it('applies the cp boundary without inventing exact outcome preservation', () => {
        const frontier = acceptanceFrontierFromMultiPv({
            lines: lines([60, -40, -60, -100]),
            requestedMultiPv: 4,
            alternativesComplete: true,
            policy,
        });
        expect(frontier.status).toBe('STABLE');
        expect(frontier.moves.map((x) => x.moveUci)).not.toContain('g1f3');
        const metrics = metricsFromPovScores({
            moveUci: 'g1f3',
            originalMoveUci: '',
            trainingSide: 'w',
            bestScore: { kind: 'cp', cp: 60, pov: 'WHITE' },
            submittedScore: { kind: 'cp', cp: -60, pov: 'WHITE' },
            originalScore: null,
        });
        expect(policy.success.preserveOutcome).toBe(true);
        expect(metrics.preservesOutcome).toBeNull();
    });
    it('retains unchanged acceptable membership across tier-only drift', () => {
        const first = acceptanceFrontierFromMultiPv({
            lines: lines([100, 81, -70]),
            requestedMultiPv: 3,
            alternativesComplete: true,
            policy,
        });
        const second = acceptanceFrontierFromMultiPv({
            lines: lines([100, 79, -70]),
            requestedMultiPv: 3,
            alternativesComplete: true,
            policy,
        });
        expect(first.moves.map((x) => x.moveUci)).toEqual(
            second.moves.map((x) => x.moveUci),
        );
        expect(confirmAcceptanceFrontier(first, second).status).toBe('STABLE');
    });
    it('requires cp quality even when matched WDL is saturated', () => {
        const saturated = lines([1000, 800, 600]);
        saturated.forEach((x) => {
            x.wdl = { win: 1000, draw: 0, loss: 0 };
        });
        const frontier = acceptanceFrontierFromMultiPv({
            lines: saturated,
            requestedMultiPv: 3,
            alternativesComplete: true,
            policy,
        });
        expect(
            evaluationLoss(
                { score: saturated[0]!.score, wdl: saturated[0]!.wdl },
                { score: saturated[1]!.score, wdl: saturated[1]!.wdl },
            ).winningChance,
        ).toBe(0);
        expect(frontier.moves.map((x) => x.moveUci)).not.toContain('d2d4');
    });
    it('treats mate zero as a loss for the side to move', () => {
        expect(winningChance({ type: 'mate', value: 0 })).toBe(0);
        expect(
            evaluationLoss(
                { score: { type: 'mate', value: 1 } },
                { score: negateScore({ type: 'mate', value: 0 }) },
            ),
        ).toEqual({ cp: null, winningChance: 1 });
    });
    it('completes full extraction when the played move checkmates', async () => {
        const position = new Chess();
        position.move('f3');
        position.move('e5');
        position.move('g4');
        const startFen = position.fen();
        let fen = startFen;
        const runtime: ServerStockfishRuntime = {
            sendCommand(command) {
                if (command === 'uci')
                    queueMicrotask(() => runtime.listener?.('uciok'));
                else if (command === 'isready')
                    queueMicrotask(() => runtime.listener?.('readyok'));
                else if (command.startsWith('position fen '))
                    fen = command.slice('position fen '.length);
                else if (command.startsWith('go '))
                    queueMicrotask(() => {
                        if (new Chess(fen).isCheckmate()) {
                            runtime.listener?.('info depth 0 score mate 0');
                            runtime.listener?.('bestmove (none)');
                        } else {
                            runtime.listener?.(
                                'info depth 4 multipv 1 score mate 1 wdl 1000 0 0 nodes 1000 pv d8h4',
                            );
                            runtime.listener?.('bestmove d8h4');
                        }
                    });
            },
            terminate() {},
        };
        const client = new ServerStockfishClient({
            runtimeFactory: async () => runtime,
        });
        try {
            await expect(
                extractTrainingMomentsFromGames({
                    selectedGameIds: new Set(['audit-mate']),
                    games: [
                        {
                            id: 'audit-mate',
                            provider: 'lichess',
                            playedAt: '2026-09-05T00:00:00Z',
                            timeClass: 'rapid',
                            white: { name: 'opponent' },
                            black: { name: 'adam' },
                            provenance: { username: 'adam', userSide: 'black' },
                            pgn: `[SetUp "1"]\n[FEN "${startFen}"]\n[Result "0-1"]\n\n2... Qh4# 0-1`,
                        },
                    ],
                    engine: client,
                    options: { returnAnalysis: true },
                }),
            ).resolves.toMatchObject({
                manifests: [expect.objectContaining({ complete: true })],
            });
        } finally {
            client.terminate();
        }
    });
});
