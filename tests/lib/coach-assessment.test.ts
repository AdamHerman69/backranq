import { describe, expect, it } from 'vitest';

import {
    assessUserMove,
    coachInterventionLabel,
} from '@/lib/coach/assessment';

describe('CP-primary user move assessment', () => {
    it('reverses the post-move side-to-move evaluation into the player POV', () => {
        const assessment = assessUserMove({
            before: {
                score: { type: 'cp', value: 120 },
                wdl: { win: 700, draw: 200, loss: 100 },
            },
            after: {
                // After White moves, Stockfish owns Black's POV.
                score: { type: 'cp', value: 60 },
                wdl: { win: 550, draw: 300, loss: 150 },
            },
            thresholdCp: 180,
        });

        expect(assessment.playerEvaluationAfter).toEqual({
            score: { type: 'cp', value: -60 },
            wdl: { win: 150, draw: 300, loss: 550 },
        });
        expect(assessment.loss.cp).toBe(180);
        expect(assessment.loss.winningChance).toBeCloseTo(0.5);
        expect(assessment.shouldIntervene).toBe(true);
        expect(assessment.severity).toBe('mistake');
        expect(assessment.outcomeReason).toBeNull();
    });

    it('uses CP loss for the intervention gate even when WDL barely changes', () => {
        const assessment = assessUserMove({
            before: {
                score: { type: 'cp', value: 1_000 },
                wdl: { win: 600, draw: 300, loss: 100 },
            },
            after: {
                // Reverses to +500 and W/D/L 550/300/150 for the player.
                score: { type: 'cp', value: -500 },
                wdl: { win: 150, draw: 300, loss: 550 },
            },
            thresholdCp: 500,
        });

        expect(assessment.loss.cp).toBe(500);
        expect(assessment.loss.winningChance).toBeCloseTo(0.05);
        expect(assessment.shouldIntervene).toBe(true);
        expect(assessment.severity).toBe('blunder');
    });

    it('honors the custom CP threshold boundary exactly', () => {
        const args = {
            before: {
                score: { type: 'cp' as const, value: 60 },
            },
            after: {
                // Player POV after inversion is -40: exactly 100 cp lost.
                score: { type: 'cp' as const, value: 40 },
            },
        };

        expect(
            assessUserMove({
                ...args,
                thresholdCp: 101,
            }).shouldIntervene
        ).toBe(false);
        expect(
            assessUserMove({
                ...args,
                thresholdCp: 100,
            }).shouldIntervene
        ).toBe(true);
    });

    it('does not invent a loss when the move improves the player evaluation', () => {
        const assessment = assessUserMove({
            before: {
                score: { type: 'cp', value: 0 },
            },
            after: {
                score: { type: 'cp', value: -80 },
            },
            thresholdCp: 20,
        });

        expect(assessment.playerEvaluationAfter.score).toEqual({
            type: 'cp',
            value: 80,
        });
        expect(assessment.loss.cp).toBe(0);
        expect(assessment.loss.winningChance).toBe(0);
        expect(assessment.shouldIntervene).toBe(false);
        expect(assessment.outcomeReason).toBeNull();
    });

    it('always catches allowing a new forced mate', () => {
        const assessment = assessUserMove({
            before: {
                score: { type: 'cp', value: 20 },
            },
            after: {
                // Opponent to move can force mate, so player POV is mate -2.
                score: { type: 'mate', value: 2 },
            },
            thresholdCp: 1_000,
        });

        expect(assessment.playerEvaluationAfter.score).toEqual({
            type: 'mate',
            value: -2,
        });
        expect(assessment.loss.cp).toBeNull();
        expect(assessment.outcomeReason).toBe('allowed-forced-mate');
        expect(assessment.shouldIntervene).toBe(true);
        expect(assessment.severity).toBe('blunder');
    });

    it('always catches losing a forced mate, including a transition to a draw', () => {
        const assessment = assessUserMove({
            before: {
                score: { type: 'mate', value: 3 },
            },
            after: {
                score: { type: 'cp', value: 0 },
                wdl: { win: 0, draw: 1_000, loss: 0 },
            },
            thresholdCp: 1_000,
        });

        const playerScoreAfter = assessment.playerEvaluationAfter.score;
        expect(playerScoreAfter).not.toBeNull();
        if (!playerScoreAfter) {
            throw new Error('Expected a player-perspective score after the move.');
        }
        expect(playerScoreAfter.type).toBe('cp');
        expect(playerScoreAfter.value === 0).toBe(true);
        expect(assessment.outcomeReason).toBe('lost-forced-mate');
        expect(assessment.shouldIntervene).toBe(true);
        expect(assessment.severity).toBe('blunder');
    });

    it('does not flag preserving the same explicit mate outcome as a transition', () => {
        const stillLosing = assessUserMove({
            before: {
                score: { type: 'mate', value: -4 },
            },
            after: {
                // Inverts to player mate -2.
                score: { type: 'mate', value: 2 },
            },
            thresholdCp: 20,
        });
        const stillWinning = assessUserMove({
            before: {
                score: { type: 'mate', value: 4 },
            },
            after: {
                // Inverts to player mate +2.
                score: { type: 'mate', value: -2 },
            },
            thresholdCp: 20,
        });

        expect(stillLosing.outcomeReason).toBeNull();
        expect(stillLosing.shouldIntervene).toBe(false);
        expect(stillWinning.outcomeReason).toBeNull();
        expect(stillWinning.shouldIntervene).toBe(false);
    });

    it('provides stable user-facing labels for every severity', () => {
        expect(coachInterventionLabel('inaccuracy')).toBe('Inaccuracy');
        expect(coachInterventionLabel('mistake')).toBe('Mistake');
        expect(coachInterventionLabel('blunder')).toBe('Big mistake');
    });
});
