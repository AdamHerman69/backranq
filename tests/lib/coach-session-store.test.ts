import { Chess, type Square } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type { MultiPvResult } from '@/lib/analysis/stockfishClient';
import { moveToUci } from '@/lib/chess/utils';
import { assessUserMove } from '@/lib/coach/assessment';
import {
    sanitizeCoachSessionSnapshot,
} from '@/lib/coach/sessionStore';
import type {
    CoachActiveSessionSnapshot,
    CoachMistake,
    CoachPlayedMove,
    CoachSessionSnapshot,
} from '@/lib/coach/types';
import {
    COACH_FIRST_PASS_NODES,
    COACH_THRESHOLD_DEFAULT_CP,
} from '@/lib/coach/verification';
import {
    MAIA_OPPONENT_DEFAULT_ELO,
    MAIA_TACTICAL_GUARD_REVISION,
    STOCKFISH_OPPONENT_REVISION,
} from '@/lib/coach/profiles';

const NOW = Date.UTC(2026, 6, 31, 0, 0, 0);
const START_FEN = new Chess().fen();

function analysis(
    fen: string,
    moveUci: string,
    cp: number
): MultiPvResult {
    return {
        fen,
        bestMoveUci: moveUci,
        alternativesComplete: true,
        lines: [
            {
                multipv: 1,
                pvUci: [moveUci],
                score: { type: 'cp', value: cp },
                wdl: { win: 400, draw: 400, loss: 200 },
                depth: 16,
                nodes: COACH_FIRST_PASS_NODES,
            },
        ],
    };
}

function playMoves(
    userColor: 'w' | 'b',
    movesUci: string[]
): {
    chess: Chess;
    moves: CoachPlayedMove[];
    positionFens: string[];
} {
    const chess = new Chess();
    const moves: CoachPlayedMove[] = [];
    const positionFens = [chess.fen()];
    for (const uci of movesUci) {
        const fenBefore = chess.fen();
        const actor = chess.turn() === userColor ? 'player' : 'bot';
        const played = chess.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            promotion: uci.slice(4, 5) || undefined,
        })!;
        const record: CoachPlayedMove = {
            ply: moves.length,
            actor,
            san: played.san,
            uci: moveToUci(played),
            fenBefore,
            fenAfter: chess.fen(),
            from: played.from as Square,
            to: played.to as Square,
        };
        moves.push(record);
        positionFens.push(record.fenAfter);
    }
    return { chess, moves, positionFens };
}

function snapshot(
    overrides: Partial<CoachActiveSessionSnapshot> = {}
): CoachActiveSessionSnapshot {
    return {
        version: 4,
        sessionKey: 'coach-session-1',
        ownerId: 'user-1',
        savedAt: NOW,
        phase: 'player',
        userColor: 'w',
        opponentModel: 'stockfish',
        opponentId: 'club',
        opponentElo: null,
        opponentEngineRevision: STOCKFISH_OPPONENT_REVISION,
        tacticalGuardCp: null,
        thresholdCp: 100,
        gameFen: START_FEN,
        moves: [],
        positionFens: [START_FEN],
        baseline: analysis(START_FEN, 'e2e4', 20),
        pendingDecision: null,
        mistake: null,
        mistakes: [],
        flipped: false,
        ...overrides,
    };
}

function afterE4Snapshot(
    phase: 'bot' | 'checking' | 'confirming' | 'mistake'
): CoachSessionSnapshot {
    const replayed = playMoves('w', ['e2e4']);
    const beforeAnalysis = analysis(START_FEN, 'e2e4', 30);
    return snapshot({
        phase,
        gameFen: replayed.chess.fen(),
        moves: replayed.moves,
        positionFens: replayed.positionFens,
        baseline: null,
        pendingDecision:
            phase === 'checking' || phase === 'confirming'
                ? {
                      record: replayed.moves[0]!,
                      beforeAnalysis,
                  }
                : null,
    });
}

function mistakeAfterE4(): CoachMistake {
    const replayed = playMoves('w', ['e2e4']);
    const beforeAnalysis = analysis(START_FEN, 'd2d4', 120);
    const afterAnalysis = analysis(replayed.chess.fen(), 'e7e5', 80);
    const afterEvaluation = {
        score: { type: 'cp' as const, value: 80 },
        wdl: { win: 500, draw: 300, loss: 200 },
    };
    const assessment = assessUserMove({
        before: {
            score: { type: 'cp', value: 120 },
            wdl: { win: 600, draw: 300, loss: 100 },
        },
        after: afterEvaluation,
        thresholdCp: 100,
    });
    return {
        id: 'coach-session-1:0:e2e4',
        decisionPly: 0,
        decisionFen: START_FEN,
        fenAfterMove: replayed.chess.fen(),
        positionHistory: [START_FEN],
        moveUci: 'e2e4',
        moveSan: 'e4',
        bestMoveUci: 'd2d4',
        bestLineUci: ['d2d4'],
        beforeAnalysis,
        afterAnalysis,
        afterEvaluation,
        assessment,
        verification: {
            firstPassNodes: COACH_FIRST_PASS_NODES,
            confirmationNodes: null,
            firstPassLossCp: assessment.loss.cp,
            confirmedLossCp: null,
            confirmationRan: false,
            stable: true,
            interventionConfirmed: false,
        },
    };
}

describe('coach session snapshot sanitization', () => {
    it('requires a bounded local owner namespace', () => {
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), ownerId: '' },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), ownerId: 'x'.repeat(257) },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(snapshot(), NOW)?.ownerId
        ).toBe('user-1');
    });

    it('never restores a session into a different or anonymous owner namespace', () => {
        expect(
            sanitizeCoachSessionSnapshot(
                snapshot(),
                NOW,
                'user-2'
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                snapshot(),
                NOW,
                'local'
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                snapshot(),
                NOW,
                'user-1'
            )?.ownerId
        ).toBe('user-1');
    });

    it('rejects obsolete snapshot contracts instead of restoring aliases', () => {
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), version: 3 },
                NOW
            )
        ).toBeNull();
    });

    it('normalizes and locks Maia opponent metadata', () => {
        const restored = sanitizeCoachSessionSnapshot(
            {
                ...snapshot(),
                opponentModel: 'maia3',
                opponentElo: 1524,
                opponentEngineRevision: ' maia3-engine-v1 ',
            },
            NOW
        );

        expect(restored).toMatchObject({
            opponentModel: 'maia3',
            opponentElo: 1500,
            opponentEngineRevision: 'maia3-engine-v1',
        });
        expect(restored?.opponentElo).toBe(MAIA_OPPONENT_DEFAULT_ELO);
    });

    it('persists a normalized tactical guard threshold only for the hybrid model', () => {
        const guarded = sanitizeCoachSessionSnapshot(
            {
                ...snapshot(),
                opponentModel: 'maia3-tactical',
                opponentElo: 1_725,
                opponentEngineRevision:
                    MAIA_TACTICAL_GUARD_REVISION,
                tacticalGuardCp: 147,
            },
            NOW
        );
        expect(guarded).toMatchObject({
            version: 4,
            opponentModel: 'maia3-tactical',
            opponentElo: 1_750,
            opponentEngineRevision:
                MAIA_TACTICAL_GUARD_REVISION,
            tacticalGuardCp: 150,
        });
    });

    it('restores a valid player checkpoint and normalizes untrusted preferences', () => {
        const candidate = {
            ...snapshot(),
            thresholdCp: '149.6',
            flipped: 'yes',
            positionFens: ['forged'],
        };
        const restored = sanitizeCoachSessionSnapshot(candidate, NOW);

        expect(restored).not.toBeNull();
        expect(restored?.thresholdCp).toBe(150);
        expect(restored?.flipped).toBe(false);
        expect(restored?.positionFens).toEqual([START_FEN]);
    });

    it('retains a completed game snapshot until explicit save or discard', () => {
        const replayed = playMoves('w', [
            'f2f3',
            'e7e5',
            'g2g4',
            'd8h4',
        ]);
        const restored = sanitizeCoachSessionSnapshot(
            {
                ...snapshot(),
                phase: 'gameover',
                completedAt: '2026-07-31T00:00:00.000Z',
                gameFen: replayed.chess.fen(),
                moves: replayed.moves,
                positionFens: replayed.positionFens,
                baseline: null,
            },
            NOW
        );

        expect(restored).toMatchObject({
            version: 4,
            phase: 'gameover',
            completedAt: '2026-07-31T00:00:00.000Z',
        });
        expect(restored?.moves).toHaveLength(4);
    });

    it('legally replays moves and replaces forged derived move metadata', () => {
        const replayed = playMoves('w', ['e2e4', 'e7e5']);
        const candidate = snapshot({
            gameFen: replayed.chess.fen(),
            moves: replayed.moves.map((move) => ({
                ...move,
                ply: 99,
                san: 'forged',
                fenBefore: 'forged',
                fenAfter: 'forged',
                from: 'a1',
                to: 'a8',
            })),
            positionFens: ['forged'],
            baseline: null,
        });
        const restored = sanitizeCoachSessionSnapshot(candidate, NOW);

        expect(restored?.moves).toMatchObject([
            {
                ply: 0,
                actor: 'player',
                san: 'e4',
                uci: 'e2e4',
                fenBefore: START_FEN,
                from: 'e2',
                to: 'e4',
            },
            {
                ply: 1,
                actor: 'bot',
                san: 'e5',
                uci: 'e7e5',
                from: 'e7',
                to: 'e5',
            },
        ]);
        expect(restored?.positionFens).toEqual(replayed.positionFens);
    });

    it('restores checking checkpoints only with matching pending evidence', () => {
        const valid = afterE4Snapshot('checking');
        expect(sanitizeCoachSessionSnapshot(valid, NOW)?.phase).toBe(
            'checking'
        );

        const mismatched = {
            ...valid,
            pendingDecision: {
                ...valid.pendingDecision,
                beforeAnalysis: analysis(
                    valid.gameFen,
                    'e7e5',
                    10
                ),
            },
        };
        expect(sanitizeCoachSessionSnapshot(mismatched, NOW)).toBeNull();
    });

    it('enforces phase/turn consistency for player and bot checkpoints', () => {
        const afterE4 = afterE4Snapshot('bot');
        expect(sanitizeCoachSessionSnapshot(afterE4, NOW)?.phase).toBe('bot');
        expect(
            sanitizeCoachSessionSnapshot(
                { ...afterE4, phase: 'player' },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), phase: 'bot' },
                NOW
            )
        ).toBeNull();
    });

    it('rejects illegal, malformed, and wrong-actor move histories', () => {
        const afterE4 = afterE4Snapshot('bot');
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...afterE4,
                    moves: [{ ...afterE4.moves[0], uci: 'e2e5' }],
                },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...afterE4,
                    moves: [
                        {
                            ...afterE4.moves[0],
                            uci: 'e2e4junk',
                        },
                    ],
                },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...afterE4,
                    moves: [{ ...afterE4.moves[0], actor: 'bot' }],
                },
                NOW
            )
        ).toBeNull();
    });

    it('restores a valid paused mistake tied to the replayed player move', () => {
        const mistake = mistakeAfterE4();
        const candidate = {
            ...afterE4Snapshot('mistake'),
            mistake,
            mistakes: [mistake],
        };
        const restored = sanitizeCoachSessionSnapshot(candidate, NOW);

        expect(restored?.phase).toBe('mistake');
        expect(restored?.mistake).toMatchObject({
            decisionPly: 0,
            decisionFen: START_FEN,
            fenAfterMove: candidate.gameFen,
            moveUci: 'e2e4',
        });
    });

    it('rejects a paused mistake whose decision evidence is unrelated to the replay', () => {
        const mistake = {
            ...mistakeAfterE4(),
            decisionFen: new Chess()
                .move('d4')
                .after,
        };
        const candidate = {
            ...afterE4Snapshot('mistake'),
            mistake,
            mistakes: [mistake],
        };

        expect(sanitizeCoachSessionSnapshot(candidate, NOW)).toBeNull();
    });

    it('rejects malformed baseline and nested mistake evidence', () => {
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...snapshot(),
                    baseline: { definitely: 'not analysis' },
                },
                NOW
            )
        ).toBeNull();

        const mistake = {
            ...mistakeAfterE4(),
            assessment: 'forged',
            verification: 'forged',
        };
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...afterE4Snapshot('mistake'),
                    mistake,
                    mistakes: [mistake],
                },
                NOW
            )
        ).toBeNull();
    });

    it('rejects unsupported, stale, future, oversized, and invalid-profile snapshots', () => {
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), version: 3 },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                {
                    ...snapshot(),
                    savedAt: NOW - 31 * 24 * 60 * 60 * 1_000,
                },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), savedAt: NOW + 60_001 },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), opponentId: 'impossible' },
                NOW
            )
        ).toBeNull();
        expect(
            sanitizeCoachSessionSnapshot(
                { ...snapshot(), sessionKey: 'x'.repeat(2_000_001) },
                NOW
            )
        ).toBeNull();
    });

    it('defaults an invalid persisted threshold without invalidating the game', () => {
        const restored = sanitizeCoachSessionSnapshot(
            {
                ...snapshot(),
                thresholdCp: 'not-a-number',
            },
            NOW
        );

        expect(restored?.thresholdCp).toBe(COACH_THRESHOLD_DEFAULT_CP);
    });
});
