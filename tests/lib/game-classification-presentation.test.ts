import { describe, expect, it } from 'vitest';

import {
    getClassificationLabel,
    getClassificationSymbol,
    type MoveClassification,
} from '@/lib/analysis/classification';

describe('game review classification presentation', () => {
    it('gives every classification a visible symbol and readable label', () => {
        const classifications: MoveClassification[] = [
            'brilliant',
            'great',
            'best',
            'excellent',
            'good',
            'book',
            'inaccuracy',
            'mistake',
            'blunder',
        ];

        for (const classification of classifications) {
            expect(getClassificationSymbol(classification)).not.toBe('');
            expect(getClassificationLabel(classification)).toMatch(/^[A-Z]/);
        }
    });
});
