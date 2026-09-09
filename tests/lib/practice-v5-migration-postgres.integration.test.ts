import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { jsonToGameAnalysis } from '@/lib/api/games';
import { weeklyMasterConfig } from '@/lib/master/config';
import { createMasterPipelineRun } from '@/lib/master/pipeline';
import { masterContentHash } from '@/lib/master/ranking';

const currentSnapshot = { version: 4, extraction: { extractor: { selectionPolicyId: 'practice-selection-t2-v1' } } };
async function applyCutover(tx: Prisma.TransactionClient) {
    const sql = readFileSync('prisma/migrations/20260909122319_practice_v5_clean_cutover/migration.sql', 'utf8');
    for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(s => s && s !== 'BEGIN' && s !== 'COMMIT')) await tx.$executeRawUnsafe(statement);
}

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
// Run this suite on its own: it exercises the migration's global cleanup within
// a rolled-back transaction, before the concurrent application integration lane.
integration('v5 cutover preserves sources and settles incompatible work', () => {
    it('resets obsolete Master daily keys and queued work while preserving source snapshots', async () => {
        const db = new PrismaClient();
        const rollback = new Error('ROLLBACK_MASTER_FIXTURE');
        try {
            await expect(db.$transaction(async tx => {
                const now = new Date('2026-09-07T12:00:00Z');
                const runKey = 'weekly-master:2026-09-07';
                const succeeded = await tx.masterPipelineRun.create({ data: {
                    runKey, status: 'SUCCEEDED', completedAt: now,
                    configSnapshot: { version: 'obsolete' }, configHash: 'obsolete',
                } });
                const queued = await tx.masterPipelineRun.create({ data: {
                    runKey: `weekly-master:obsolete:${randomUUID()}`, status: 'QUEUED',
                    configSnapshot: { version: 'obsolete' }, configHash: 'obsolete',
                } });
                const source = await tx.masterSourceGame.create({ data: {
                    provider: 'LICHESS', externalId: randomUUID(),
                } });
                const snapshot = await tx.masterSourceGameSnapshot.create({ data: {
                    sourceGameId: source.id, pipelineRunId: succeeded.id,
                    snapshotHash: 'migration-master-snapshot', pgnHash: 'migration-master-pgn',
                    pgn: '1. e4 e5 *', playedAt: now, timeClass: 'RAPID',
                    whiteName: 'Master fixture', blackName: 'Opponent fixture',
                    providerMetadata: { source: 'migration-regression' },
                } });
                const sourceBefore = await tx.masterSourceGame.update({
                    where: { id: source.id }, data: { currentSnapshotId: snapshot.id },
                });
                // The old completed key is returned even while its config and
                // all of its published output are obsolete.
                expect((await createMasterPipelineRun(tx, { trigger: 'SCHEDULED', now })).id).toBe(succeeded.id);
                const person = await tx.masterPerson.create({ data: { slug: randomUUID(), displayName: 'Migration', attributionLabel: 'Migration' } });
                const account = await tx.masterAccount.create({ data: { personId: person.id, provider: 'LICHESS', username: randomUUID(), usernameNormalized: randomUUID(), profileUrl: 'https://lichess.org/@/fixture' } });
                const candidateData = { snapshotId: snapshot.id, personId: person.id, accountId: account.id, pipelineRunId: succeeded.id,
                    candidateKey: randomUUID(), decisionPly: 0, fen: 'fixture', sideToMove: 'w', originalMoveUci: 'e2e4', scoreBefore: {}, scoreAfter: {},
                    manifest: { contractVersion: 4 }, trainable: true, solutionHash: 'old', generatorVersion: 'old', configHash: 'old',
                    hardGatePassed: true, freshnessScore: 1, recognitionScore: 1, clarityScore: 1, engineConfidenceScore: 1, humanInterestScore: 1, solutionLengthScore: 1, totalScore: 6, status: 'ELIGIBLE' as const };
                const candidate = await tx.masterCandidate.create({ data: candidateData });
                const publication = await tx.masterPublication.create({ data: { candidateId: candidate.id, slug: randomUUID(), headline: 'Old', teaser: 'Old', attributionLabel: 'Old',
                    promptPayload: { grading: { contractVersion: 4 } }, reviewPayload: {}, contentHash: randomUUID() } });
                const slot = await tx.masterSlot.create({ data: { key: randomUUID(), currentPublicationId: publication.id, fallbackPublicationId: publication.id } });
                await tx.masterAnalysisReceipt.create({ data: { snapshotId: snapshot.id, accountId: account.id, pipelineRunId: succeeded.id, configHash: 'old', complete: true } });
                const currentRun = await tx.masterPipelineRun.create({ data: { runKey: randomUUID(), status: 'SUCCEEDED', configHash: 'current', configSnapshot: { analysis: { snapshot: currentSnapshot } } } });
                const currentCandidate = await tx.masterCandidate.create({ data: { ...candidateData, candidateKey: randomUUID(), pipelineRunId: currentRun.id, configHash: 'current', manifest: { contractVersion: 5 } } });
                await applyCutover(tx);
                expect(await tx.masterCandidate.findUnique({ where: { id: candidate.id } })).toBeNull();
                expect(await tx.masterPublication.findUnique({ where: { id: publication.id } })).toBeNull();
                expect(await tx.masterAnalysisReceipt.count({ where: { pipelineRunId: succeeded.id } })).toBe(0);
                expect(await tx.masterSlot.findUnique({ where: { id: slot.id } })).toMatchObject({ currentPublicationId: null, fallbackPublicationId: null, version: 1 });
                expect(await tx.masterCandidate.findUnique({ where: { id: currentCandidate.id } })).toEqual(currentCandidate);
                expect(await tx.masterPipelineRun.findUnique({ where: { id: currentRun.id } })).toEqual(currentRun);
                expect(await tx.masterPerson.findUnique({ where: { id: person.id } })).toEqual(person);
                expect(await tx.masterAccount.findUnique({ where: { id: account.id } })).toEqual(account);
                expect(await tx.masterPipelineRun.count({ where: { id: { in: [succeeded.id, queued.id] } } })).toBe(0);
                expect(await tx.masterSourceGameSnapshot.findUnique({ where: { id: snapshot.id } })).toEqual({ ...snapshot, pipelineRunId: null });
                expect(await tx.masterSourceGame.findUnique({ where: { id: source.id } })).toEqual(sourceBefore);
                const rebuilt = await createMasterPipelineRun(tx, { trigger: 'SCHEDULED', now });
                const config = { ...weeklyMasterConfig(), scope: 'FULL', targetSourceGameId: null };
                expect(rebuilt.id).not.toBe(succeeded.id);
                expect(rebuilt).toMatchObject({ runKey, status: 'QUEUED', configSnapshot: config, configHash: masterContentHash(config) });
                throw rollback;
            }, { timeout: 30_000 })).rejects.toBe(rollback);
        } finally { await db.$disconnect(); }
    }, 35_000);

    it.each([{ limit: 30, balance: 4 }, { limit: 20, balance: 8 }])('cancels incompatible work and settles period reservations within allowance $limit/$balance', async ({ limit, balance }) => {
        const db = new PrismaClient();
        const rollback = new Error('ROLLBACK_FIXTURE');
        try {
            await expect(db.$transaction(async tx => {
                const user = await tx.user.create({ data: {} });
                const period = new Date('2026-09-01T00:00:00Z');
                const previousPeriod = new Date('2026-08-01T00:00:00Z');
                await tx.billingAccount.create({ data: { userId: user.id, serverCreditsPeriodStart: period, serverCreditsBalance: balance, monthlyServerCreditsLimit: limit, monthlyServerCreditsUsed: 2 } });
                const game = await tx.analyzedGame.create({ data: { userId: user.id, provider: 'LICHESS', externalId: randomUUID(), pgn: '1. e4 e5 *', plyCount: 2, sourcePgnHash: 'migration-source', sourceUsername: 'migration', userSide: 'WHITE', playedAt: period, timeClass: 'RAPID', whiteName: 'migration', blackName: 'opponent', analysis: {} } });
                const makeRun = (version: number, status: 'QUEUED' | 'SUCCEEDED' = 'QUEUED') => tx.analysisRun.create({ data: { userId: user.id, gameId: game.id, executionMode: 'SERVER_QUEUE', analysisQuality: 'THOROUGH', creditCost: 10, status, configSnapshot: { version }, configHash: `v${version}`, inputPgnHash: game.sourcePgnHash } });
                const obsolete = await makeRun(4);
                const currentGame = await tx.analyzedGame.create({ data: { ...game, id: randomUUID(), externalId: randomUUID(), analysis: {} } });
                const current = await tx.analysisRun.create({ data: { ...obsolete, id: randomUUID(), gameId: currentGame.id, engineOptions: {}, configSnapshot: currentSnapshot, configHash: 'v5', analysisQuality: 'T2' } });
                const terminal = await makeRun(4, 'SUCCEEDED');
                await tx.analyzedGame.update({ where: { id: game.id }, data: { currentAnalysisRunId: terminal.id, currentAnalysisValid: true, analyzedAt: period, whiteAccuracy: 91, blackAccuracy: 83, analysis: { moves: [{ hasTrainingMoment: true }], trainingExtraction: { version: 1, summary: { savedPositions: 3 } } } } });
                await tx.analyzedGame.update({ where: { id: currentGame.id }, data: { currentAnalysisRunId: current.id, currentAnalysisValid: true, analyzedAt: period, analysis: { moves: [], trainingExtraction: { version: 2, summary: { savedPositions: 0 } } } } });
                const currentProjection = await tx.analyzedGame.findUniqueOrThrow({ where: { id: currentGame.id } });
                const job = await tx.analysisJob.create({ data: { userId: user.id, gameId: game.id, analysisRunId: obsolete.id, status: 'RUNNING', lockedAt: period, lockedUntil: new Date('2027-01-01') } });
                await tx.analysisRunCheckpoint.createMany({ data: [ { runId: obsolete.id, state: { version: 1 } }, { runId: current.id, state: { version: 2 } } ] });
                const batch = await tx.analysisBatch.create({ data: { userId: user.id, requestId: randomUUID(), status: 'QUEUED', payloadHash: 'migration', queuedReason: 'USER', configSnapshot: { version: 4 }, configHash: 'v4', analysisQuality: 'THOROUGH', creditCost: 10, totalItems: 1, pendingItems: 0, queuedItems: 1 } });
                await tx.analysisBatchItem.create({ data: { batchId: batch.id, userId: user.id, gameId: game.id, analysisJobId: job.id, analysisRunId: obsolete.id, status: 'QUEUED' } });
                const outbox = await tx.analysisOutbox.create({ data: { analysisJobId: job.id, kind: 'ANALYSIS_JOB', payload: {}, idempotencyKey: randomUUID() } });
                const published = await tx.analysisOutbox.create({ data: { analysisJobId: job.id, kind: 'ANALYSIS_JOB', status: 'PUBLISHED', payload: {}, idempotencyKey: randomUUID() } });
                const unrelated = await tx.analysisOutbox.create({ data: { kind: 'ANALYSIS_BATCH_PLAN', payload: {}, idempotencyKey: randomUUID() } });
                const ledger = (runId: string, billingPeriodStart: Date, type: 'RESERVED' | 'CONSUMED' | 'EXPIRED' | 'RELEASED', credits: number) => tx.creditLedgerEntry.create({ data: { userId: user.id, analysisRunId: runId, analysisJobId: runId === obsolete.id && type === 'RESERVED' ? job.id : null, gameId: game.id, scope: 'RESERVATION', billingPeriodStart, type, credits, idempotencyKey: randomUUID() } });
                await ledger(obsolete.id, period, 'RESERVED', 10);
                await tx.creditLedgerEntry.create({ data: { userId: user.id, analysisJobId: job.id, gameId: game.id, scope: 'RESERVATION', billingPeriodStart: period, type: 'CONSUMED', credits: 2, idempotencyKey: randomUUID() } });
                await ledger(obsolete.id, period, 'RELEASED', 2);
                await ledger(obsolete.id, period, 'EXPIRED', 1);
                await ledger(obsolete.id, previousPeriod, 'RESERVED', 8);
                await ledger(obsolete.id, previousPeriod, 'EXPIRED', 3);
                await ledger(current.id, period, 'RESERVED', 7);
                const sourceBefore = await tx.analyzedGame.findUniqueOrThrow({ where: { id: game.id } });
                const terminalBefore = await tx.analysisRun.findUniqueOrThrow({ where: { id: terminal.id } });
                const makeMoment = async (gameId: string, runId: string, version: number) => {
                    const moment = await tx.trainingMoment.create({ data: { userId: user.id, gameId, momentKey: randomUUID(), sourcePgnHash: game.sourcePgnHash, decisionPly: 0,
                        fen: 'fixture', sideToMove: 'w', originalMoveUci: 'e2e4', scoreBefore: {}, scoreAfter: {} } });
                    const revision = await tx.solutionRevision.create({ data: { momentId: moment.id, analysisRunId: runId, revision: 1, solutionHash: randomUUID(),
                        manifest: { contractVersion: version }, generatorVersion: 'fixture', configHash: `v${version}`, trainable: true } });
                    await tx.trainingMoment.update({ where: { id: moment.id }, data: { currentSolutionRevisionId: revision.id } });
                    const attempt = await tx.trainingAttempt.create({ data: { userId: user.id, trainingMomentId: moment.id, solutionRevisionId: revision.id,
                        clientAttemptId: randomUUID(), clientPayloadHash: 'fixture', contextProvider: 'LICHESS', contextTimeClass: 'RAPID', contextConfigHash: `v${version}`, contextSolutionHash: revision.solutionHash } });
                    await tx.practiceReviewState.create({ data: { userId: user.id, trainingMomentId: moment.id, solutionHash: revision.solutionHash, configHash: `v${version}`,
                        nextDueAt: period, intervalDays: 1, algorithmVersion: 'fixture', lastReviewedAt: period } });
                    return { moment, revision, attempt };
                };
                const oldGraph = await makeMoment(game.id, terminal.id, 4);
                const freshGraph = await makeMoment(currentGame.id, current.id, 5);
                await applyCutover(tx);
                expect(await tx.trainingMoment.findUnique({ where: { id: oldGraph.moment.id } })).toBeNull();
                expect(await tx.solutionRevision.findUnique({ where: { id: oldGraph.revision.id } })).toBeNull();
                expect(await tx.trainingAttempt.findUnique({ where: { id: oldGraph.attempt.id } })).toBeNull();
                expect(await tx.practiceReviewState.count({ where: { trainingMomentId: oldGraph.moment.id } })).toBe(0);
                expect(await tx.solutionRevision.findUnique({ where: { id: freshGraph.revision.id } })).toEqual(freshGraph.revision);
                expect(await tx.trainingAttempt.findUnique({ where: { id: freshGraph.attempt.id } })).toEqual(freshGraph.attempt);
                expect(await tx.practiceReviewState.count({ where: { trainingMomentId: freshGraph.moment.id } })).toBe(1);
                expect(await tx.analysisJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', lockedAt: null, lockedUntil: null });
                expect(await tx.analysisRun.findUnique({ where: { id: obsolete.id } })).toMatchObject({ status: 'CANCELLED', consumedCredits: 2 });
                expect(await tx.analysisRun.findUnique({ where: { id: current.id } })).toMatchObject({ status: 'QUEUED' });
                expect(await tx.analysisRun.findUnique({ where: { id: terminal.id } })).toEqual(terminalBefore);
                const sourceAfter = await tx.analyzedGame.findUniqueOrThrow({ where: { id: game.id } });
                const sourceColumns = (row: typeof sourceBefore) => Object.fromEntries(Object.entries(row).filter(([key]) => !['analysis', 'whiteAccuracy', 'blackAccuracy', 'analyzedAt', 'currentAnalysisRunId', 'currentAnalysisValid', 'updatedAt'].includes(key)));
                expect(sourceColumns(sourceAfter)).toEqual(sourceColumns(sourceBefore));
                expect(sourceAfter).toMatchObject({ analysis: null, whiteAccuracy: null, blackAccuracy: null, analyzedAt: null, currentAnalysisRunId: null, currentAnalysisValid: false });
                expect(jsonToGameAnalysis(sourceAfter.analysis)).toBeNull();
                expect(await tx.analyzedGame.findUnique({ where: { id: currentGame.id } })).toEqual(currentProjection);
                expect(await tx.analysisRunCheckpoint.findMany({ where: { runId: { in: [obsolete.id, current.id] } } })).toMatchObject([{ runId: current.id }]);
                expect(await tx.analysisBatch.findUnique({ where: { id: batch.id } })).toMatchObject({ status: 'CANCELLED', cancelledItems: 1, queuedItems: 0, pendingItems: 0 });
                expect(await tx.analysisOutbox.findUnique({ where: { id: outbox.id } })).toBeNull();
                expect(await tx.analysisOutbox.count({ where: { id: { in: [published.id, unrelated.id] } } })).toBe(2);
                expect(await tx.creditLedgerEntry.findMany({ where: { userId: user.id, type: 'RELEASED' }, orderBy: [{ billingPeriodStart: 'asc' }, { credits: 'asc' }] })).toMatchObject([{ credits: 5, billingPeriodStart: previousPeriod }, { credits: 2, billingPeriodStart: period }, { credits: 5, billingPeriodStart: period }]);
                // The old-period 5 never replenishes this allowance. Current-period 5
                // restores only up to limit minus used minus the v5 reservation.
                expect(await tx.billingAccount.findUnique({ where: { userId: user.id } })).toMatchObject({ serverCreditsBalance: Math.min(balance + 5, limit - 2 - 7), monthlyServerCreditsUsed: 2 });
                throw rollback;
            }, { timeout: 30_000 })).rejects.toBe(rollback);
        } finally { await db.$disconnect(); }
    }, 35_000);
});
