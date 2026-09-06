import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { expect, test } from '@playwright/test';
import { PrismaClient, Prisma } from '@prisma/client';
import { assessmentPositionKey } from '../../src/lib/training/assessmentIdentity';
import { dragMove, waitForBoard } from './support/board';
import { E2E_USER, E2E_TRAINING_MOMENTS, practicePath } from './support/fixtures';

const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const best = 'f7g7';
const original = 'f7e6';
const submitted = 'f7h7';
const contextId = assessmentPositionKey(fen, []);
const bestScore = { kind: 'mate', plies: 1, winner: 'WHITE' };
const drawScore = { kind: 'tablebase', wdl: 'DRAW', pov: 'WHITE' };

/** Deliberately bounded consumer fixture; extraction provenance is covered separately. */
async function installMateFixture(prisma: PrismaClient, certifiedWrong: boolean) {
    const base = await prisma.trainingMoment.findUniqueOrThrow({ where: { id: E2E_TRAINING_MOMENTS.offline }, include: { currentSolutionRevision: true } });
    const id = randomUUID();
    const revisionId = randomUUID();
    const legalMovesUci = new Chess(fen).moves({ verbose: true }).map(move => move.lan);
    const coverage = { version: 1, contextId, status: certifiedWrong ? 'QUALITY_BOUNDARY_VERIFIED' : 'PARTIAL', legalMovesUci, assessedMovesUci: [best, original], coveredMovesUci: certifiedWrong ? legalMovesUci.filter(move => move !== best && move !== original) : [], referenceId: revisionId, policyVersion: 3, reason: 'E2E_CONSUMER_EVIDENCE', evidence: { kind: 'E2E_SUPERSEDED_BOUNDARY' } };
    await prisma.trainingMoment.create({ data: { id, userId: E2E_USER.id, gameId: base.gameId, momentKey: id, sourcePgnHash: id, decisionPly: 0, fen, sideToMove: 'w', positionHistory: [], originalMoveUci: original, scoreBefore: bestScore, scoreAfter: drawScore, phase: 'ENDGAME', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], status: 'ACTIVE' } });
    await prisma.solutionRevision.create({ data: {
        id: revisionId, momentId: id, analysisRunId: base.currentSolutionRevision!.analysisRunId, revision: 1, solutionHash: revisionId, verificationStatus: 'VERIFIED', solutionShape: 'UNIQUE', gradingStrategy: 'PRECOMPUTED', continuationShape: 'SINGLE_DECISION', trainable: true,
        bestMoveUci: best, acceptedMovesUci: [best], acceptanceFrontier: { version: 1, status: 'STABLE', targetCutoffCp: 100, effectiveCutoffCp: null, boundaryGapCp: null, moves: [{ moveUci: best, tier: 'BEST' }], firstRejectedMoveUci: original },
        decision: { status: 'CONFIRMED_MISTAKE', reason: 'E2E_MATE_VS_STALEMATE' }, answerCoverage: coverage, continuation: { status: 'NONE', explanationAvailable: false, gradedContinuationReady: false },
        originalDecision: { fen, sideToMove: 'w', positionHistory: [], originalMoveUci: original, scoreBefore: bestScore, scoreAfter: drawScore, cpLoss: null, winChanceLoss: 1, phase: 'ENDGAME', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], themes: [] },
        bestLine: [best], solutionTree: { fen, contextId, positionHistory: [], answerCoverage: coverage, ply: 0, role: 'USER', acceptedMovesUci: [best], branches: [] }, scoreAtStart: bestScore,
        gradingPolicy: base.currentSolutionRevision!.gradingPolicy as Prisma.InputJsonValue, generatorVersion: 'e2e-local-evidence', configHash: base.currentSolutionRevision!.configHash,
        moveAssessments: { create: [
            { positionKey: contextId, referenceId: revisionId, tierStable: true, decisionIndex: 0, fen, moveUci: best, source: 'PRECOMPUTED', status: 'VERIFIED', grade: 'BEST', scoreAfter: bestScore, evidence: { evidenceModel: 'EXACT_OUTCOME', stable: true, bestGapWinChance: 0, preservesOutcome: true } },
            { positionKey: contextId, referenceId: revisionId, tierStable: true, decisionIndex: 0, fen, moveUci: original, source: 'PRECOMPUTED', status: 'VERIFIED', grade: 'REPEATED_MISTAKE', scoreAfter: drawScore, evidence: { evidenceModel: 'EXACT_OUTCOME', stable: true, bestGapWinChance: 1, preservesOutcome: false } },
        ] },
    } });
    await prisma.trainingMoment.update({ where: { id }, data: { currentSolutionRevisionId: revisionId } });
    return { id, revisionId };
}

for (const certifiedWrong of [false, true]) {
    test(certifiedWrong ? 'corrects an initial covered verdict with real local WASM without duplicating the attempt' : 'grades a partial-coverage unknown mate with real local WASM and persists personal evidence', async ({ page }) => {
        test.setTimeout(60_000);
        const prisma = new PrismaClient();
        const fixture = await installMateFixture(prisma, certifiedWrong);
        const posts: Array<Record<string, unknown>> = [];
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.method() === 'POST' && request.url().includes(`/moments/${fixture.id}/attempts`)) posts.push(request.postDataJSON());
        });
        try {
            await page.goto(practicePath(fixture.id));
            await waitForBoard(page);
            await dragMove(page, submitted.slice(0, 2), submitted.slice(2, 4));
            await expect(page.getByText('Best move — well found.')).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('[data-board-stage]')).toHaveAttribute('data-board-marker', 'BEST');
            if (certifiedWrong) await expect(page.getByText('Further analysis corrected the initial verdict. Your attempt is preserved.')).toBeVisible();
            await expect.poll(() => prisma.trainingAttempt.count({ where: { trainingMomentId: fixture.id } })).toBe(1);
            const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } });
            if (certifiedWrong) {
                await expect.poll(() => prisma.trainingAttemptAssessmentRevision.count({ where: { attemptId: attempt.id } })).toBe(1);
                const refinement = await prisma.trainingAttemptAssessmentRevision.findFirstOrThrow({ where: { attemptId: attempt.id } });
                expect(attempt.grade).toBe('DIFFERENT_MISTAKE');
                expect(refinement).toMatchObject({ grade: 'BEST', gradingSource: 'CLIENT_EVALUATED', corrected: true });
                expect(posts.map(post => post.kind)).toEqual(['RECORD', 'ENRICH']);
                expect(posts[0].clientAttemptId).toBe(posts[1].clientAttemptId);
            } else {
                expect(attempt).toMatchObject({ grade: 'BEST', gradingSource: 'CLIENT_EVALUATED' });
                expect(attempt.gradingEvidence).toMatchObject({ serverVerified: false, trust: 'CLIENT_EVALUATED' });
                expect(posts).toHaveLength(1);
            }
            expect(await prisma.solutionRevision.count({ where: { momentId: fixture.id } })).toBe(1);
            expect((await prisma.trainingMoment.findUniqueOrThrow({ where: { id: fixture.id } })).currentSolutionRevisionId).toBe(fixture.revisionId);
            expect(errors).toEqual([]);
            await page.screenshot({ path: `test-results/practice-local-${certifiedWrong ? 'correction' : 'unknown'}.png`, fullPage: true });
        } finally {
            await prisma.trainingMoment.delete({ where: { id: fixture.id } });
            await prisma.$disconnect();
        }
    });
}

test('retries one worker failure and saves a neutral review without an unresolved dead end', async ({ page }) => {
    test.setTimeout(60_000);
    const prisma = new PrismaClient();
    const fixture = await installMateFixture(prisma, false);
    let workerLoads = 0;
    await page.route('**/vendor/stockfish/backranq-engine.worker.js**', async route => {
        workerLoads += 1;
        await route.abort('failed');
    });
    try {
        await page.goto(practicePath(fixture.id));
        await waitForBoard(page);
        await dragMove(page, submitted.slice(0, 2), submitted.slice(2, 4));
        await expect(page.getByText('This move could not be graded reliably. Review the position below.')).toBeVisible({ timeout: 30_000 });
        expect(workerLoads).toBe(2);
        await expect(page.getByRole('button', { name: 'Retry grading' })).toHaveCount(0);
        await expect(page.locator('[data-board-stage]')).not.toHaveAttribute('data-board-marker', /.+/);
        await expect.poll(() => prisma.trainingAttempt.count({ where: { trainingMomentId: fixture.id } })).toBe(1);
        const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } });
        expect(attempt).toMatchObject({ status: 'REVEALED', grade: null, gradingSource: null, userMoveUci: submitted });
        expect(attempt.gradingEvidence).toMatchObject({ trust: 'UNASSESSED', serverVerified: false });
        await page.screenshot({ path: 'test-results/practice-local-neutral.png', fullPage: true });
    } finally {
        await prisma.trainingMoment.delete({ where: { id: fixture.id } });
        await prisma.$disconnect();
    }
});
