import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backgroundBarSource = readFileSync(
    'src/components/analysis/BackgroundAnalysisBar.tsx',
    'utf8'
);
const syncWidgetSource = readFileSync(
    'src/components/sync/SyncGamesWidget.tsx',
    'utf8'
);

describe('protected app request boundaries', () => {
    it('reuses the compact sync snapshot for the global analysis inventory', () => {
        expect(backgroundBarSource).toContain(
            'getSyncStatus({ ownerId, preferCached: options.preferCached })'
        );
        expect(backgroundBarSource).toContain(
            'nextStatus.inventory.unanalyzed'
        );
        expect(backgroundBarSource).toContain(
            'initialAnalysisStatusDelayMs('
        );
        expect(backgroundBarSource).toContain(
            'refreshAll({ preferCached: true })'
        );
        expect(backgroundBarSource).not.toContain(
            'refreshPendingUnanalyzedCount('
        );
        expect(backgroundBarSource).not.toContain(
            '/api/games?hasAnalysis=false&page=1&limit=1'
        );
    });

    it('does not issue separate game-count requests from the sync widget', () => {
        expect(syncWidgetSource).not.toContain('fetchLibraryCounts');
        expect(syncWidgetSource).not.toContain(
            '/api/games?hasAnalysis=false&page=1&limit=1'
        );
    });
});
