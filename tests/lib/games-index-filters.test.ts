import { describe, expect, it } from 'vitest';
import {
    gamesAnalysisStateWhere,
    parseGamesDateBound,
} from '@/lib/games/indexFilters';

describe('Games index filters used by Progress actions', () => {
    it('keeps the entire end calendar day', () => {
        expect(
            parseGamesDateBound('2026-07-30', 'end')
        ).toEqual(new Date('2026-07-30T23:59:59.999Z'));
        expect(
            parseGamesDateBound(
                '2026-07-30T12:34:56.000Z',
                'end'
            )
        ).toEqual(new Date('2026-07-30T12:34:56.000Z'));
        expect(
            parseGamesDateBound('2026-02-30', 'end')
        ).toBeNull();
    });

    it('includes stale and unfinished current runs in needs analysis', () => {
        expect(
            gamesAnalysisStateWhere('needs-analysis')
        ).toEqual({
            currentAnalysisValid: false,
        });
        expect(gamesAnalysisStateWhere('analyzed')).toEqual({
            currentAnalysisValid: true,
        });
    });
});
