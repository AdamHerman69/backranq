import { describe, expect, it, vi } from 'vitest';
import {
    hasCurrentMasterAnalysisConfig,
    weeklyMasterConfig,
} from '@/lib/master/config';
import { hashAnalysisConfig } from '@/lib/services/analysisRuns';
import { analyzeMasterSnapshot } from '@/lib/master/analysis';

const { findSnapshot } = vi.hoisted(() => ({ findSnapshot: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
    prisma: { masterSourceGameSnapshot: { findUnique: findSnapshot } },
}));

describe('Master enqueue-time analysis provenance', () => {
    it('accepts the current canonical analysis snapshot and matching options', () => {
        expect(hasCurrentMasterAnalysisConfig(weeklyMasterConfig().analysis)).toBe(true);
    });

    it('rejects an old nested version even with a correct hash and current Master version', () => {
        const config = weeklyMasterConfig();
        const snapshot = { ...config.analysis.snapshot, version: 2 };
        expect(config.version).toBe(2);
        expect(hasCurrentMasterAnalysisConfig({
            ...config.analysis,
            snapshot,
            configHash: hashAnalysisConfig(snapshot),
        })).toBe(false);
    });

    it('rejects a mismatched hash and separately altered execution options', () => {
        const analysis = weeklyMasterConfig().analysis;
        expect(hasCurrentMasterAnalysisConfig({ ...analysis, configHash: 'wrong' })).toBe(false);
        expect(hasCurrentMasterAnalysisConfig({
            ...analysis,
            options: { ...analysis.options, returnAnalysis: false },
        })).toBe(false);
    });

    it.each([null, [], {}, { configHash: 'hash', snapshot: null }])(
        'rejects malformed nested provenance %j',
        (value) => expect(hasCurrentMasterAnalysisConfig(value)).toBe(false)
    );

    it('also protects the direct snapshot entry point before reading or writing data', async () => {
        const config = weeklyMasterConfig();
        config.analysis.configHash = 'wrong';
        await expect(analyzeMasterSnapshot({
            snapshotId: 'snapshot',
            accountId: 'account',
            pipelineRunId: 'run',
            config,
        })).rejects.toThrow('Master analysis configuration is invalid');
        expect(findSnapshot).not.toHaveBeenCalled();
    });
});
