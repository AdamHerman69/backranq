import { describe, expect, it } from 'vitest';

import {
    classifyPuzzleMove,
    legalPromotionChoices,
    isStateForPuzzle,
    appendAnalysisBranch,
    analysisHistoryStepLabel,
    mayShowPuzzleContext,
} from '@/lib/puzzles/trainerUx';

describe('puzzle trainer UX rules', () => {
    it('distinguishes best, accepted alternatives, and wrong moves', () => {
        const input = {
            bestMove: 'e2e4',
            acceptedMoves: ['e2e4', 'd2d4'],
        };

        expect(classifyPuzzleMove({ ...input, move: 'E2E4' })).toBe('best');
        expect(classifyPuzzleMove({ ...input, move: 'd2d4' })).toBe('accepted');
        expect(classifyPuzzleMove({ ...input, move: 'g1f3' })).toBe('wrong');
    });

    it('seeds a sandbox branch from the displayed PV step', () => {
        const next = appendAnalysisBranch({
            history: ['root-fen'],
            historyIndex: 0,
            displayedFen: 'pv-step-fen',
            nextFen: 'user-move-fen',
        });

        expect(next).toEqual(['pv-step-fen', 'user-move-fen']);
        expect(
            analysisHistoryStepLabel({
                historyLength: next.length,
                historyIndex: 0,
            })
        ).toBe('Your analysis · branch point');
        expect(
            analysisHistoryStepLabel({
                historyLength: next.length,
                historyIndex: 1,
            })
        ).toBe('Your analysis · move 1');
    });

    it('preserves earlier sandbox history when continuing from its current step', () => {
        expect(
            appendAnalysisBranch({
                history: ['branch', 'move-1', 'stale-redo'],
                historyIndex: 1,
                displayedFen: 'move-1',
                nextFen: 'move-2',
            })
        ).toEqual(['branch', 'move-1', 'move-2']);
    });

    it('never discloses state carried from another puzzle', () => {
        expect(isStateForPuzzle('puzzle-a', 'puzzle-a')).toBe(true);
        expect(isStateForPuzzle('puzzle-a', 'puzzle-b')).toBe(false);
        expect(isStateForPuzzle(null, 'puzzle-b')).toBe(false);
    });

    it('opens promotion choices only for legal promotion moves', () => {
        const moves = [
            { from: 'a7', to: 'a8', promotion: 'q' },
            { from: 'a7', to: 'a8', promotion: 'r' },
            { from: 'a7', to: 'a8', promotion: 'b' },
            { from: 'a7', to: 'a8', promotion: 'n' },
            { from: 'a7', to: 'b8' },
        ];

        expect(legalPromotionChoices(moves, 'a7', 'a8')).toEqual([
            'q',
            'r',
            'b',
            'n',
        ]);
        expect(legalPromotionChoices(moves, 'a7', 'h8')).toEqual([]);
    });

    it('keeps new puzzles spoiler-free unless context was deliberately enabled', () => {
        expect(
            mayShowPuzzleContext({
                preferenceEnabled: false,
                attempted: false,
            })
        ).toBe(false);
        expect(
            mayShowPuzzleContext({
                preferenceEnabled: true,
                attempted: false,
            })
        ).toBe(true);
        expect(
            mayShowPuzzleContext({
                preferenceEnabled: false,
                attempted: true,
            })
        ).toBe(true);
        expect(
            mayShowPuzzleContext({
                preferenceEnabled: false,
                attempted: false,
                explicitContextFilter: true,
            })
        ).toBe(true);
    });
});
