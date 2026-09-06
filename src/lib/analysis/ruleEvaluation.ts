import { Chess } from 'chess.js';
import {
    assessmentPositionKey,
    repetitionPositionKey,
} from '@/lib/training/assessmentIdentity';
import type { EvalResult } from '@/lib/analysis/stockfishClient';

/** Rule-exact board result. Claimable draws are handled separately from game-over. */
export function ruleTerminalEvaluation(
    fen: string,
    previousFens: readonly string[] = [],
): EvalResult | null {
    const chess = new Chess(fen);
    const currentPositionKey = repetitionPositionKey(fen);
    const kind = chess.isCheckmate()
        ? 'CHECKMATE'
        : chess.isStalemate()
          ? 'STALEMATE'
          : chess.isInsufficientMaterial()
            ? 'INSUFFICIENT_MATERIAL'
            : Number(chess.fen().split(' ')[4]) >= 150
              ? 'SEVENTY_FIVE_MOVE_RULE'
              : previousFens.filter(
                      (previous) =>
                          repetitionPositionKey(previous) ===
                          currentPositionKey,
                  ).length >= 4
                ? 'FIVEFOLD_REPETITION'
                : null;
    if (!kind) return null;
    const loss = kind === 'CHECKMATE';
    return {
        fen,
        bestMoveUci: '',
        pvUci: [],
        score: loss ? { type: 'mate', value: 0 } : { type: 'cp', value: 0 },
        wdl: loss
            ? { win: 0, draw: 0, loss: 1000 }
            : { win: 0, draw: 1000, loss: 0 },
        searchEvidence: {
            id: `rule:${kind}:${assessmentPositionKey(fen, previousFens)}`,
            source: 'RULE',
            engine: {
                name: 'Chess rules',
                version: '1',
                source: 'chess.js',
                options: {},
            },
            request: {
                fen,
                previousFens: [...previousFens],
                rootMoves: [],
                historyMode: previousFens.length ? 'REPLAY' : 'FEN_ONLY',
                purpose: 'TERMINAL_RULE',
                multiPv: 0,
                limits: {},
            },
            reported: { nodes: 0, timeMs: 0 },
            reused: false,
        },
        terminal: {
            kind,
            outcome: loss ? 'LOSS' : 'DRAW',
            pov: 'SIDE_TO_MOVE',
        },
    };
}

export function claimableDraw(
    fen: string,
    previousFens: readonly string[],
): 'FIFTY_MOVE_RULE' | 'THREEFOLD_REPETITION' | null {
    if (new Chess(fen).isCheckmate()) return null;
    if (Number(fen.split(' ')[4]) >= 100) return 'FIFTY_MOVE_RULE';
    const key = (value: string) =>
        new Chess(value).fen().split(' ').slice(0, 4).join(' ');
    const current = key(fen);
    return previousFens.filter((position) => key(position) === current)
        .length >= 2
        ? 'THREEFOLD_REPETITION'
        : null;
}
