import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PublicPuzzlePlayer } from '@/components/landing/PublicPuzzlePlayer';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';
import { initialBoardPresentation } from '@/lib/training/boardPresentation';

const session = vi.hoisted(() => vi.fn());
vi.mock('@/lib/hooks/usePublicPuzzleSession', () => ({ usePublicPuzzleSession: session }));
vi.mock('@/components/training/PuzzleBoard', () => ({ PuzzleBoard: () => null }));

it('announces a corrected public verdict only for the active puzzle', () => {
    const state = { prompt: WARMUP_PUZZLE.prompt, terminal: true, reviewFallback: false, phase: 'GRADED',
        grade: 'SUBPAR', review: null, presentation: initialBoardPresentation(), displayFen: WARMUP_PUZZLE.prompt.fen,
        canMove: false, canReveal: false, refinement: 'CORRECTED' };
    session.mockReturnValue(state);
    const render = () => renderToStaticMarkup(createElement(PublicPuzzlePlayer, { puzzle: WARMUP_PUZZLE }));
    const message = 'Further analysis corrected the initial verdict. Your attempt is preserved.';
    expect(render()).toContain(`role="status">${message}</p>`);
    session.mockReturnValue({ ...state, refinement: 'PENDING' });
    expect(render()).not.toContain(message);
    session.mockReturnValue({ ...state, prompt: { ...state.prompt, solutionRevisionId: 'previous-revision' } });
    expect(render()).not.toContain(message);
});
