import { describe, expect, it } from 'vitest';

import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';
import { legalMoveFromInput } from '@/lib/training/boardInput';

describe('shared puzzle board input', () => {
    const rootFen = WARMUP_PUZZLE.prompt.fen;

    it('normalizes SAN and coordinate notation to the same UCI move', () => {
        const san = legalMoveFromInput(rootFen, 'Qf8#');
        const coordinate = legalMoveFromInput(rootFen, 'F7F8');

        expect(san?.moveUci).toBe('f7f8');
        expect(coordinate).toEqual(san);
    });

    it('rejects illegal and malformed moves without changing the position', () => {
        expect(legalMoveFromInput(rootFen, 'Qb5')).toBeNull();
        expect(legalMoveFromInput(rootFen, 'not-a-move')).toBeNull();
        expect(legalMoveFromInput(rootFen, '')).toBeNull();
    });

    it('preserves an explicit promotion piece in UCI output', () => {
        const promotionFen = '7k/P7/8/8/8/8/8/7K w - - 0 1';

        expect(
            legalMoveFromInput(promotionFen, 'a7a8n')?.moveUci
        ).toBe('a7a8n');
    });
});
