/** Regression checks for defects first reproduced by the 8739124 audit. */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { assessMove } from '@/lib/training/assessmentPolicy';
import { practiceV4Fixture } from '../helpers/practice-v4';
import {
    evaluationLoss,
    negateScore,
    winningChance,
} from '@/lib/analysis/evaluation';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
describe('chess audit regressions', () => {
    it('applies adaptive cp quality without inventing rule-exact preservation', () => {
        const revision = practiceV4Fixture();
        const assess = () => assessMove(revision.frames[0], { id: 'audit', moveUci: 'd2d4', originalMoveUci: 'a2a3', referenceMoveUci: 'e2e4', trainingSide: 'WHITE', evidence: revision.evidence });
        expect(assess().quality).toBe('GOOD');
        expect(assess().metrics.preservesExactOutcome).toBeNull();
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -150, pov: 'WHITE' };
        expect(assess().quality).toBe('BELOW_STANDARD');
    });
    it('retains supported membership while exact tiers vary across complete depths', () => {
        const revision = practiceV4Fixture();
        for (const [index, observation] of Object.values(revision.evidence.observations).entries()) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: index % 2 ? 9 : 11, pov: 'WHITE' };
        const answer = assessMove(revision.frames[0], { id: 'audit', moveUci: 'd2d4', originalMoveUci: 'a2a3', referenceMoveUci: 'e2e4', trainingSide: 'WHITE', evidence: revision.evidence });
        expect(answer.quality).toBe('GOOD'); expect(answer.qualitySupport).toBe('SUPPORTED'); expect(answer.tier).toBeNull();
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
