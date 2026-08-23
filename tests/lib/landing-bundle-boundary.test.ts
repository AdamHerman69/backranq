import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const heroSource = readFileSync(
    'src/components/landing/DualOnboardingHero.tsx',
    'utf8'
);

describe('landing client bundle boundary', () => {
    it('loads the personal extraction pipeline only after a valid identity lookup', () => {
        const identityLookup = heroSource.indexOf(
            'await fetchOnboardingGames('
        );
        const personalFinderImport = heroSource.indexOf(
            "import('@/lib/onboarding/personalPuzzleFinder')"
        );

        expect(identityLookup).toBeGreaterThan(-1);
        expect(personalFinderImport).toBeGreaterThan(identityLookup);
        expect(heroSource).not.toMatch(
            /^import \{[^}]*findFirstVerifiedPersonalPuzzle[^}]*\} from/m
        );
    });

    it('keeps Stockfish construction behind user intent', () => {
        const stockfishImport = heroSource.indexOf(
            "import('@/lib/analysis/stockfishClient')"
        );
        const engineConstruction = heroSource.indexOf(
            'new StockfishClient()'
        );

        expect(stockfishImport).toBeGreaterThan(-1);
        expect(engineConstruction).toBeGreaterThan(stockfishImport);
        expect(heroSource).not.toContain(
            "import { StockfishClient } from '@/lib/analysis/stockfishClient'"
        );
    });
});
