import { describe, expect, it } from 'vitest';

import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';
import {
    buildPostMoveStory,
    storyFrames,
} from '@/lib/training/postMoveStory';

describe('shared post-move story', () => {
    const prompt = WARMUP_PUZZLE.prompt;

    it('builds only fully legal animation frames', () => {
        const frames = storyFrames(prompt.fen, ['f7f8']);

        expect(frames).toHaveLength(2);
        expect(frames[0]?.moveUci).toBeNull();
        expect(frames[1]?.moveUci).toBe('f7f8');
        expect(frames[1]?.fen).toBe(
            '5Q1k/8/6K1/8/8/8/8/8 b - - 1 1'
        );
    });

    it('stops before malformed or illegal evidence', () => {
        expect(storyFrames(prompt.fen, ['f7f8', 'h8h7'])).toHaveLength(2);
        expect(storyFrames('not-a-fen', ['f7f8'])).toEqual([]);
    });

    it('provides the same user, game, and best-line segments to every surface', () => {
        const story = buildPostMoveStory({
            prompt,
            review: {
                ...prompt.grading.review,
                submittedMoveUci: 'f7e8',
            },
            grade: 'BEST',
        });

        expect(story.promptKey).toBe(
            `${prompt.id}:${prompt.solutionRevisionId}`
        );
        expect(story.segments.map((segment) => segment.kind)).toEqual([
            'YOUR_MOVE',
            'GAME_LINE',
            'BEST_LINE',
        ]);
        expect(
            story.segments.every(
                (segment) =>
                    segment.evidence === 'PRECOMPUTED' &&
                    segment.frames.length === segment.movesUci.length + 1
            )
        ).toBe(true);
    });
});
