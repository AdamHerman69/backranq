import { beforeEach, describe, expect, it, vi } from 'vitest';
import { weeklyMasterConfig } from '@/lib/master/config';

const mocks = vi.hoisted(() => ({
    extract: vi.fn(),
    findSnapshot: vi.fn(),
    transaction: vi.fn(),
    terminate: vi.fn(),
    lock: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {
    masterSourceGameSnapshot: { findUnique: mocks.findSnapshot },
    $transaction: mocks.transaction,
} }));
vi.mock('@/lib/analysis/extractTrainingMoments', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/analysis/extractTrainingMoments')>(),
    extractTrainingMomentsFromGames: mocks.extract,
}));
vi.mock('@/lib/analysis/serverStockfishClient', () => ({
    ServerStockfishClient: class { terminate = mocks.terminate; },
}));
vi.mock('@/lib/master/ranking', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/master/ranking')>(),
    rankMasterCandidate: () => ({ hardGatePassed: true }),
}));

import { analyzeMasterSnapshot } from '@/lib/master/analysis';

type Row = Record<string, unknown>;
let candidates: Row[];
let receipt: Row | null;
let failReceipt: boolean;
let physicalSearch: number;
const snapshotId = '00000000-0000-4000-8000-000000000001';
const pgnHash = 'a'.repeat(64);
const manifest = {
    version: 1, sourceGameId: snapshotId, sourcePgnHash: pgnHash,
    scope: 'FULL_GAME', complete: true, scanComplete: true, extractionComplete: true,
    expectedPlies: 4, scannedPlies: 4, termination: 'COMPLETED',
    errors: [], decisionOutcomes: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    candidates = [];
    receipt = null;
    failReceipt = false;
    physicalSearch = 0;
    mocks.findSnapshot.mockResolvedValue({
        id: snapshotId, pgnHash, pgn: '1. e4 e5 *',
        playedAt: new Date('2026-09-01'), timeClass: 'BLITZ',
        sourceGame: { provider: 'LICHESS', discoveries: [{
            featuredSide: 'WHITE',
            account: { id: 'account', personId: 'person', username: 'player', person: { priority: 90 } },
        }] },
    });
    mocks.extract.mockImplementation(async () => ({
        manifests: [manifest],
        moments: [1, 3].map(decisionPly => ({
            sourceGameId: snapshotId, decisionPly,
            originalDecision: { scoreBefore: {}, scoreAfter: {} },
            solution: {
                configHash: weeklyMasterConfig().analysis.configHash,
                evidence: { physicalSearch: ++physicalSearch },
            },
        })),
    }));
    // Model PostgreSQL atomic commit/rollback while requiring every content write
    // to use the same transaction handle (there are no global write mocks).
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
        expect(mocks.extract).toHaveResolved();
        const pending = candidates.slice();
        let pendingReceipt = receipt;
        const tx = {
            $queryRaw: mocks.lock,
            masterCandidate: {
                findMany: async () => pending,
                upsert: async ({ create }: { create: Row }) => {
                    const sameIdentity = pending.find(row =>
                        row.snapshotId === create.snapshotId &&
                        row.personId === create.personId &&
                        row.decisionPly === create.decisionPly &&
                        row.configHash === create.configHash
                    );
                    if (sameIdentity && sameIdentity.candidateKey !== create.candidateKey) {
                        throw new Error('MasterCandidate compound identity conflict');
                    }
                    if (sameIdentity) return sameIdentity;
                    pending.push(create);
                    return create;
                },
            },
            masterAnalysisReceipt: {
                findUnique: async () => pendingReceipt,
                upsert: async ({ create }: { create: Row }) => {
                    if (failReceipt) throw new Error('receipt write failed');
                    pendingReceipt = create;
                    return create;
                },
            },
        };
        const result = await work(tx);
        candidates = pending;
        receipt = pendingReceipt;
        return result;
    });
});

function analyze() {
    return analyzeMasterSnapshot({
        snapshotId, accountId: 'account', pipelineRunId: 'run',
        config: weeklyMasterConfig(),
    });
}

describe('Master atomic extraction persistence', () => {
    it('does not persist a completed scan with extraction errors', async () => {
        mocks.extract.mockResolvedValue({
            manifests: [{ ...manifest, errors: ['Ply 2: engine failure'] }],
            moments: [],
        });
        await expect(analyze()).rejects.toThrow('complete receipt');
        expect(mocks.transaction).not.toHaveBeenCalled();
        expect(receipt).toBeNull();
    });

    it('rejects a stored complete receipt with invalid evidence instead of reusing it', async () => {
        await analyze();
        receipt = { ...receipt, manifest: { ...manifest, errors: ['engine failure'] } };
        await expect(analyze()).rejects.toThrow('current completion contract');
        expect(candidates).toHaveLength(2);
    });

    it('rolls back every candidate when receipt persistence fails, then retries once', async () => {
        failReceipt = true;
        await expect(analyze()).rejects.toThrow('receipt write failed');
        expect(candidates).toEqual([]);
        expect(receipt).toBeNull();
        expect(mocks.terminate).toHaveBeenCalledTimes(1);

        failReceipt = false;
        await analyze();
        expect(candidates).toHaveLength(2);
        expect(receipt).toMatchObject({ complete: true, candidateCount: 2 });
        expect(mocks.lock).toHaveBeenCalledTimes(2);
    });

    it('retains the completed evidence on retry despite new physical search identities', async () => {
        const first = await analyze();
        const keys = candidates.map(row => row.candidateKey);
        const retried = await analyze();
        expect(mocks.extract).toHaveBeenCalledTimes(2);
        expect(candidates.map(row => row.candidateKey)).toEqual(keys);
        expect(candidates).toHaveLength(2);
        expect(retried).toEqual(first);
    });
});
