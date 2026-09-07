import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PrismaClient, Prisma } from '@prisma/client';
import { WARMUP_MANIFEST } from '../../src/lib/onboarding/warmupPuzzle';
import { practicePositionFixture } from '../helpers/practice-position';
import { canonicalJson, canonicalPracticeSemantics, parsePracticeMomentRevision } from '../../src/lib/training/practiceContract';
import { deriveRootAnswerIndex } from '../../src/lib/training/answerIndex';
import { dragMove, waitForBoard } from './support/board';
import { E2E_USER, E2E_TRAINING_MOMENTS, practicePath } from './support/fixtures';

const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const best = 'f7f8';
const original = 'f7e6';
const submitted = 'f7h7';

/** Synthetic prior evidence intentionally disagrees with the real local engine in the correction case. */
async function installMateFixture(prisma: PrismaClient, certifiedWrong: boolean) {
    const base = await prisma.trainingMoment.findUniqueOrThrow({ where: { id: E2E_TRAINING_MOMENTS.offline }, include: { currentSolutionRevision: true } });
    const id = randomUUID(); const revisionId = randomUUID();
    const manifest = certifiedWrong
        ? practicePositionFixture({ fen, originalMoveUci: original, bestMoveUci: best })
        : structuredClone(WARMUP_MANIFEST);
    Object.assign(manifest, { momentId: id, revisionId });
    Object.assign(manifest.source, { gameId: base.gameId, sourcePgnHash: id });
    manifest.assessments = manifest.assessments.filter(assessment => assessment.moveUci !== submitted);
    if (certifiedWrong) manifest.coverageGroups.push({ id: 'prior-boundary', contextId: manifest.source.contextId,
        frameId: manifest.frames[0].id, movesUci: [submitted], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED',
        evidenceIds: Object.keys(manifest.evidence.observations) });
    manifest.rootAnswerIndex = deriveRootAnswerIndex(manifest, manifest.frames[0], best);
    manifest.continuation.nodes = [{ id: 'root', ...manifest.source, role: 'USER', answerIndex: manifest.rootAnswerIndex }];
    // Source-only fields do not belong to a continuation node.
    manifest.continuation.nodes = manifest.continuation.nodes.map(node => ({ id: node.id, contextId: node.contextId,
        fen: node.fen, positionHistory: node.positionHistory, trainingSide: node.trainingSide, role: node.role, answerIndex: node.answerIndex }));
    manifest.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(manifest))).digest('hex');
    parsePracticeMomentRevision(manifest);
    await prisma.trainingMoment.create({ data: { id, userId: E2E_USER.id, gameId: base.gameId, momentKey: id, sourcePgnHash: id,
        decisionPly: 0, fen, sideToMove: 'w', positionHistory: [], originalMoveUci: original,
        scoreBefore: { kind: 'mate', plies: 1, winner: 'WHITE' }, scoreAfter: { kind: 'cp', cp: 0, pov: 'WHITE' },
        phase: 'ENDGAME', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], status: 'ACTIVE' } });
    await prisma.solutionRevision.create({ data: { id: revisionId, momentId: id,
        analysisRunId: base.currentSolutionRevision!.analysisRunId, revision: 1, solutionHash: manifest.semanticHash,
        manifest: manifest as unknown as Prisma.InputJsonValue, trainable: true,
        generatorVersion: manifest.generatorVersion, configHash: manifest.executionProfileId } });
    await prisma.trainingMoment.update({ where: { id }, data: { currentSolutionRevisionId: revisionId } });
    return { id, revisionId };
}

for (const certifiedWrong of [false, true]) {
    test(certifiedWrong ? 'corrects an initial covered verdict with terminal rules without duplicating the attempt' : 'grades a partial-coverage nonterminal move with real local WASM and persists personal evidence', async ({ page }) => {
        test.setTimeout(60_000);
        const prisma = new PrismaClient();
        const fixture = await installMateFixture(prisma, certifiedWrong);
        const playedMove = certifiedWrong ? submitted : 'f7e7';
        await page.addInitScript(() => {
            const NativeWorker = window.Worker;
            const records: unknown[] = [];
            Object.assign(window, { practiceEngineRecords: records });
            window.Worker = class extends NativeWorker {
                constructor(url: string | URL, options?: WorkerOptions) {
                    super(url, options);
                    if (String(url).includes('backranq-engine.worker')) this.addEventListener('message', event => {
                        if (records.length < 2000) records.push({ direction: 'received', at: performance.now(), data: event.data });
                    });
                }
                postMessage(message: unknown) {
                    if (records.length < 2000) records.push({ direction: 'sent', at: performance.now(), data: message });
                    super.postMessage(message);
                }
            };
        });
        let completed = false;
        const posts: Array<Record<string, unknown>> = [];
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.method() === 'POST' && request.url().includes(`/moments/${fixture.id}/attempts`)) posts.push(request.postDataJSON());
        });
        try {
            await page.goto(practicePath(fixture.id));
            await waitForBoard(page);
            await dragMove(page, playedMove.slice(0, 2), playedMove.slice(2, 4));
            await expect(page.getByText(/Best move — well found\.|Good move — (that works\.|this solution is accepted\.)|Strong move/)).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('[data-board-stage]')).toHaveAttribute('data-board-marker', /BEST|STRONG|GOOD/);
            if (certifiedWrong) await expect(page.getByText('Further analysis corrected the initial verdict. Your attempt is preserved.')).toBeVisible();
            await expect.poll(() => prisma.trainingAttempt.count({ where: { trainingMomentId: fixture.id } })).toBe(1);
            const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } });
            await expect.poll(() => prisma.trainingAttemptAssessmentRevision.count({ where: { attemptId: attempt.id } })).toBe(1);
            const refinement = await prisma.trainingAttemptAssessmentRevision.findFirstOrThrow({ where: { attemptId: attempt.id } });
            expect(refinement).toMatchObject({ resolution: 'RESOLVED', quality: 'GOOD' });
            const step = await prisma.trainingAttemptStep.findFirstOrThrow({ where: { attemptId: attempt.id } });
            expect(step).toMatchObject({ initialResolution: certifiedWrong ? 'RESOLVED' : 'PENDING',
                initialCoverageGroupId: certifiedWrong ? 'prior-boundary' : null, quality: 'GOOD' });
            expect(posts.map(post => post.kind)).toEqual(['RECORD', 'ENRICH']);
            expect(posts[0].clientAttemptId).toBe(posts[1].clientAttemptId);
            expect(await prisma.solutionRevision.count({ where: { momentId: fixture.id } })).toBe(1);
            expect((await prisma.trainingMoment.findUniqueOrThrow({ where: { id: fixture.id } })).currentSolutionRevisionId).toBe(fixture.revisionId);
            expect(errors).toEqual([]);
            await page.screenshot({ path: `test-results/practice-local-${certifiedWrong ? 'correction' : 'unknown'}.png`, fullPage: true });
            completed = true;
        } finally {
            if (!completed && !page.isClosed()) await test.info().attach('practice-engine-evidence', {
                contentType: 'application/json', body: JSON.stringify(await page.evaluate(() =>
                    (window as unknown as { practiceEngineRecords: unknown[] }).practiceEngineRecords)),
            });
            await page.close();
            await prisma.trainingMoment.delete({ where: { id: fixture.id } });
            await prisma.$disconnect();
        }
    });
}

test('worker failure saves the played move and a neutral unavailable result', async ({ page }) => {
    test.setTimeout(60_000);
    const prisma = new PrismaClient();
    const fixture = await installMateFixture(prisma, false);
    const playedMove = 'f7e7';
    let workerLoads = 0;
    await page.route('**/vendor/stockfish/backranq-engine.worker.js**', async route => {
        workerLoads += 1;
        await route.abort('failed');
    });
    try {
        await page.goto(practicePath(fixture.id));
        await waitForBoard(page);
        await dragMove(page, playedMove.slice(0, 2), playedMove.slice(2, 4));
        await expect(page.getByText('This move could not be graded reliably. Review the position below.')).toBeVisible({ timeout: 30_000 });
        expect(workerLoads).toBeGreaterThan(0);
        expect(workerLoads).toBeLessThanOrEqual(2);
        await expect(page.getByRole('button', { name: 'Retry grading' })).toHaveCount(0);
        await expect(page.locator('[data-board-stage]')).not.toHaveAttribute('data-board-marker', /.+/);
        await expect.poll(() => prisma.trainingAttempt.count({ where: { trainingMomentId: fixture.id } })).toBe(1);
        await expect.poll(async () => (await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } })).status).toBe('UNAVAILABLE');
        const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } });
        expect(attempt).toMatchObject({ status: 'UNAVAILABLE', quality: 'UNKNOWN', tier: null, userMoveUci: playedMove });
        expect(await prisma.trainingAttemptAssessmentRevision.count({ where: { attemptId: attempt.id, resolution: 'UNAVAILABLE' } })).toBe(1);
        await page.screenshot({ path: 'test-results/practice-local-neutral.png', fullPage: true });
    } finally {
        await page.close();
        await prisma.trainingMoment.delete({ where: { id: fixture.id } });
        await prisma.$disconnect();
    }
});
