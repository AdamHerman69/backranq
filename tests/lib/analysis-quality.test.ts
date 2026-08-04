import { describe, expect, it } from 'vitest';

import {
    analysisCreditsPerGame,
    analysisQualityProfile,
} from '@/lib/analysis/quality';
import {
    serverAnalysisConfigFromPreferences,
    serverAnalysisConfigFromSnapshot,
} from '@/lib/services/analysisJobs';

describe('analysis quality contract', () => {
    it('ships Thorough as the 10-credit default', () => {
        const resolved = serverAnalysisConfigFromPreferences({});

        expect(resolved.config.analysisQuality).toBe('THOROUGH');
        expect(resolved.config.creditCost).toBe(10);
        expect(resolved.options).toMatchObject({
            nodesPerPosition: 100_000,
            confirmNodes: 200_000,
            maxConfirmationNodes: 1_600_000,
            verificationNodesPerPosition: 100_000,
        });
    });

    it('resolves Standard to a smaller immutable frontier for 7 credits', () => {
        const resolved = serverAnalysisConfigFromPreferences({
            analysisQuality: 'STANDARD',
        });
        const restored = serverAnalysisConfigFromSnapshot({
            snapshot: resolved.config.snapshot,
            hash: resolved.config.hash,
        });

        expect(analysisCreditsPerGame('STANDARD')).toBe(7);
        expect(analysisQualityProfile('STANDARD').maxConfirmationNodes).toBe(
            800_000
        );
        expect(restored).not.toBeNull();
        expect(restored?.config).toMatchObject({
            analysisQuality: 'STANDARD',
            creditCost: 7,
        });
        expect(restored?.options.maxConfirmationNodes).toBe(800_000);
    });

    it('rejects a snapshot whose hash or server-derived price was changed', () => {
        const resolved = serverAnalysisConfigFromPreferences({});
        expect(
            serverAnalysisConfigFromSnapshot({
                snapshot: resolved.config.snapshot,
                hash: 'tampered',
            })
        ).toBeNull();

        expect(
            serverAnalysisConfigFromSnapshot({
                snapshot: {
                    ...resolved.config.snapshot,
                    creditCost: 7,
                },
                hash: resolved.config.hash,
            })
        ).toBeNull();
    });
});
