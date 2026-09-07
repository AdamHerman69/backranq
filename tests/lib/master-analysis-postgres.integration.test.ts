import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { practicePositionFixture } from '../helpers/practice-position';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import { Chess } from 'chess.js';

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
const db = new PrismaClient();
const ids = { person: randomUUID(), account: randomUUID(), source: randomUUID(), snapshot: randomUUID(), run: randomUUID() };
const triggerName = `master_receipt_fault_${randomUUID().replaceAll('-', '')}`;
const pgn = '1. e4 e5 2. Nf3 Nc6 *';
const pgnHash = hashSourcePgn(pgn);
let config: ReturnType<typeof import('@/lib/master/config').weeklyMasterConfig>;
let analyzeMasterSnapshot: typeof import('@/lib/master/analysis').analyzeMasterSnapshot;
let physicalSearch = 0;
const terminate = vi.fn();
const extract = vi.fn();

async function removeFault() {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "MasterAnalysisReceipt"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${triggerName}"()`);
}

integration('Master extraction atomic persistence in PostgreSQL', () => {
    beforeAll(async () => {
        vi.doMock('@/lib/prisma', () => ({ prisma: db }));
        vi.doMock('@/lib/analysis/serverStockfishClient', () => ({
            ServerStockfishClient: class { terminate = terminate; },
        }));
        vi.doMock('@/lib/analysis/extractTrainingMoments', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/lib/analysis/extractTrainingMoments')>(),
            extractTrainingMomentsFromGames: extract,
        }));
        config = (await import('@/lib/master/config')).weeklyMasterConfig();
        ({ analyzeMasterSnapshot } = await import('@/lib/master/analysis'));

        await db.masterPerson.create({ data: { id: ids.person, slug: `atomic-${ids.person}`,
            displayName: 'Atomic fixture', attributionLabel: 'Atomic fixture', priority: 90 } });
        await db.masterAccount.create({ data: { id: ids.account, personId: ids.person,
            provider: 'LICHESS', username: `atomic-${ids.account}`, usernameNormalized: `atomic-${ids.account}`,
            profileUrl: 'https://lichess.org/@/atomic-fixture' } });
        await db.masterSourceGame.create({ data: { id: ids.source, provider: 'LICHESS', externalId: ids.source } });
        await db.masterPipelineRun.create({ data: { id: ids.run, runKey: `atomic-${ids.run}`,
            configHash: config.analysis.configHash } });
        await db.masterSourceGameSnapshot.create({ data: { id: ids.snapshot, sourceGameId: ids.source,
            pipelineRunId: ids.run, snapshotHash: pgnHash, pgnHash, pgn, playedAt: new Date(),
            timeClass: 'BLITZ', whiteName: 'Atomic fixture', blackName: 'Opponent' } });
        await db.masterSourceGameDiscovery.create({ data: { sourceGameId: ids.source,
            accountId: ids.account, featuredSide: 'WHITE' } });
    });

    beforeEach(() => {
        extract.mockImplementation(async () => ({
            manifests: [{ version: 1, sourceGameId: ids.snapshot, sourcePgnHash: pgnHash,
                scope: 'FULL_GAME', complete: true, scanComplete: true, extractionComplete: true,
                expectedPlies: 4, scannedPlies: 4, termination: 'COMPLETED', errors: [], decisionOutcomes: [] }],
            moments: [0, 2].map(decisionPly => {
                const board = new Chess(); if (decisionPly === 2) { board.move('e4'); board.move('e5'); }
                const manifest = practicePositionFixture({ fen: board.fen(), originalMoveUci: decisionPly === 0 ? 'e2e4' : 'g1f3', bestMoveUci: decisionPly === 0 ? 'd2d4' : 'f1c4', gameId: ids.snapshot, sourcePgnHash: pgnHash, decisionPly, configHash: config.analysis.configHash, confirmationNodes: config.analysis.options.confirmNodes ?? 1, policy: config.analysis.options.gradingPolicy });
                Object.values(manifest.evidence.searches)[0].sessionId = `fresh-search-${++physicalSearch}`;
                return { sourceGameId: ids.snapshot, decisionPly, fen: manifest.source.fen, positionHistory: [], sideToMove: 'w', originalMoveUci: manifest.source.originalMoveUci, sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], themes: [], confidence: 0.99, phase: 'OPENING', originalDecision: originalDecisionForPracticeManifest(manifest), solution: { manifest, configHash: config.analysis.configHash } };
            }),
        }));
    });

    afterAll(async () => {
        await removeFault();
        await db.masterAnalysisReceipt.deleteMany({ where: { snapshotId: ids.snapshot } });
        await db.masterCandidate.deleteMany({ where: { snapshotId: ids.snapshot } });
        await db.masterSourceGameSnapshot.deleteMany({ where: { id: ids.snapshot } });
        await db.masterSourceGame.deleteMany({ where: { id: ids.source } });
        await db.masterAccount.deleteMany({ where: { id: ids.account } });
        await db.masterPerson.deleteMany({ where: { id: ids.person } });
        await db.masterPipelineRun.deleteMany({ where: { id: ids.run } });
        await db.$disconnect();
    });

    it('rolls back inserted candidates on receipt failure and retains immutable evidence across retries', async () => {
        // The trigger is scoped to this fixture and fails only after observing
        // both candidate INSERTs inside the actual application transaction.
        await db.$executeRawUnsafe(`CREATE FUNCTION "${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF (SELECT count(*) FROM "MasterCandidate" WHERE "snapshotId" = NEW."snapshotId") <> 2 THEN
                    RAISE EXCEPTION 'receipt failure happened before both candidates';
                END IF;
                RAISE EXCEPTION 'injected receipt failure after two candidates';
            END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "MasterAnalysisReceipt"
            FOR EACH ROW WHEN (NEW."snapshotId" = '${ids.snapshot}'::uuid) EXECUTE FUNCTION "${triggerName}"()`);
        const analyze = () => analyzeMasterSnapshot({ snapshotId: ids.snapshot, accountId: ids.account,
            pipelineRunId: ids.run, config });

        await expect(analyze()).rejects.toThrow('injected receipt failure after two candidates');
        expect(await db.masterCandidate.count({ where: { snapshotId: ids.snapshot } })).toBe(0);
        expect(await db.masterAnalysisReceipt.count({ where: { snapshotId: ids.snapshot } })).toBe(0);
        expect(terminate).toHaveBeenCalledTimes(1);

        await removeFault();
        const completed = await analyze();
        const firstRows = await db.masterCandidate.findMany({ where: { snapshotId: ids.snapshot }, orderBy: { decisionPly: 'asc' } });
        const firstReceipt = await db.masterAnalysisReceipt.findFirstOrThrow({ where: { snapshotId: ids.snapshot } });
        expect(firstRows).toHaveLength(2);
        expect(firstReceipt).toMatchObject({ complete: true, candidateCount: 2 });
        expect(completed.candidates).toHaveLength(2);

        const retried = await analyze();
        expect(extract).toHaveBeenCalledTimes(3);
        expect(physicalSearch).toBe(6);
        expect(await db.masterCandidate.findMany({ where: { snapshotId: ids.snapshot }, orderBy: { decisionPly: 'asc' } })).toEqual(firstRows);
        expect(await db.masterAnalysisReceipt.findFirstOrThrow({ where: { snapshotId: ids.snapshot } })).toEqual(firstReceipt);
        expect(retried.candidates.map(row => row.id).sort()).toEqual(firstRows.map(row => row.id).sort());
    }, 30_000);
});
