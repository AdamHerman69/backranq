import { createHash, randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { expect, test } from '@playwright/test';
import { Prisma, PrismaClient } from '@prisma/client';
import frozen from '../fixtures/practice-t2-real.json' with { type: 'json' };
import { canonicalJson, canonicalPracticeSemantics, parsePracticeMomentRevision } from '../../src/lib/training/practiceContract';
import { lookupAnswer } from '../../src/lib/training/answerIndex';
import { originalDecisionForPracticeManifest } from '../../src/lib/training/practiceSourceBinding';
import { getTrainingMomentPrompt } from '../../src/lib/training/readService';
import { dragMove, waitForBoard } from './support/board';
import { E2E_USER, practicePath } from './support/fixtures';

/** Exact paid T2 evidence: admission and answer grading intentionally differ. */
async function installRealT2(prisma: PrismaClient) {
    const gameId = randomUUID(), id = randomUUID(), revisionId = randomUUID(), runId = randomUUID();
    const manifest = parsePracticeMomentRevision(structuredClone(frozen.manifest));
    const pgnHash = createHash('sha256').update(frozen.game.pgn).digest('hex');
    expect(pgnHash).toBe(manifest.source.sourcePgnHash);
    const replay = new Chess(); replay.loadPgn(frozen.game.pgn);
    const moves = replay.history({ verbose: true });
    expect(moves[manifest.source.decisionPly]).toMatchObject({ before: manifest.source.fen, lan: manifest.source.originalMoveUci });
    expect(manifest.source.positionHistory).toEqual(moves.slice(0, manifest.source.decisionPly).map(move => move.before));
    Object.assign(manifest, { momentId: id, revisionId });
    manifest.source.gameId = gameId;
    manifest.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(manifest))).digest('hex');
    parsePracticeMomentRevision(manifest);
    expect(manifest.selection.status).toBe('INCLUDED');
    expect(lookupAnswer(manifest.rootAnswerIndex, manifest.source.originalMoveUci, manifest.assessments, manifest.coverageGroups).kind).toBe('PENDING');
    const preferred = lookupAnswer(manifest.rootAnswerIndex, manifest.rootAnswerIndex.preferredMoveUci,
        manifest.assessments, manifest.coverageGroups);
    expect(preferred).toMatchObject({ kind: 'INDIVIDUAL', quality: 'GOOD' });
    await prisma.$transaction(async tx => {
        await tx.analyzedGame.create({ data: { id: gameId, userId: E2E_USER.id, provider: 'CHESSCOM', externalId: `e2e-t2-${gameId}`,
            url: frozen.game.url, pgn: frozen.game.pgn, plyCount: moves.length, sourcePgnHash: pgnHash,
            sourceUsername: frozen.game.provenance.username, userSide: 'WHITE', playedAt: new Date(frozen.game.playedAt),
            timeClass: 'BLITZ', timeControlRaw: '180', whiteName: frozen.game.white.name, whiteRating: frozen.game.white.rating,
            blackName: frozen.game.black.name, blackRating: frozen.game.black.rating, result: frozen.game.result, analysis: {}, currentAnalysisValid: false } });
        await tx.analysisRun.create({ data: { id: runId, userId: E2E_USER.id, gameId, executionMode: 'SERVER_QUEUE', analysisQuality: 'T2',
            creditCost: 10, status: 'SUCCEEDED', inputPgnHash: pgnHash, configHash: manifest.executionProfileId,
            configSnapshot: { extractor: { confirmNodes: manifest.executionProfileSnapshot.minimumConfirmationNodes,
                gradingPolicy: manifest.policySnapshot, selectionPolicyId: manifest.selection.policyId } } as unknown as Prisma.InputJsonValue } });
        await tx.analyzedGame.update({ where: { id: gameId }, data: { currentAnalysisRunId: runId, currentAnalysisValid: true } });
        await tx.trainingMoment.create({ data: { id, userId: E2E_USER.id, gameId, momentKey: id, sourcePgnHash: pgnHash,
            decisionPly: manifest.source.decisionPly, fen: manifest.source.fen, sideToMove: 'w', positionHistory: manifest.source.positionHistory,
            originalMoveUci: manifest.source.originalMoveUci, ...originalDecisionForPracticeManifest(manifest),
            phase: 'OPENING', sourceKinds: ['MY_MISTAKE'], lessonKinds: ['AVOID_MISTAKE'], status: 'ACTIVE' } });
        await tx.solutionRevision.create({ data: { id: revisionId, momentId: id, analysisRunId: runId, revision: 1,
            solutionHash: manifest.semanticHash, manifest: manifest as unknown as Prisma.InputJsonValue, trainable: true,
            generatorVersion: manifest.generatorVersion, configHash: manifest.executionProfileId } });
        await tx.trainingMoment.update({ where: { id }, data: { currentSolutionRevisionId: revisionId } });
    });
    return { id, gameId, revisionId, moveUci: manifest.source.originalMoveUci };
}

test('real T2 selected moment grades its pending original in browser and persists one attempt plus evidence', async ({ page }) => {
    test.setTimeout(60_000);
    const prisma = new PrismaClient();
    const fixture = await installRealT2(prisma);
    const posts: Array<Record<string, unknown>> = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (request.method() === 'POST' && request.url().includes(`/moments/${fixture.id}/attempts`)) posts.push(request.postDataJSON());
    });
    try {
        const prompt = await getTrainingMomentPrompt({ db: prisma, userId: E2E_USER.id, momentId: fixture.id });
        expect(prompt?.moment.id).toBe(fixture.id);
        await page.goto(practicePath(fixture.id));
        await waitForBoard(page);
        await dragMove(page, fixture.moveUci.slice(0, 2), fixture.moveUci.slice(2, 4));
        await expect(page.getByText('This move loses too much of the position’s value.')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('[data-board-stage]')).toHaveAttribute('data-board-marker', 'SUBPAR');
        await expect.poll(() => prisma.trainingAttempt.count({ where: { trainingMomentId: fixture.id } })).toBe(1);
        const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { trainingMomentId: fixture.id } });
        await expect.poll(() => prisma.trainingAttemptAssessmentRevision.count({ where: { attemptId: attempt.id, resolution: 'RESOLVED' } })).toBe(1);
        const refinement = await prisma.trainingAttemptAssessmentRevision.findFirstOrThrow({ where: { attemptId: attempt.id } });
        expect(refinement).toMatchObject({ resolution: 'RESOLVED', quality: 'BELOW_STANDARD' });
        const step = await prisma.trainingAttemptStep.findFirstOrThrow({ where: { attemptId: attempt.id } });
        expect(step).toMatchObject({ initialResolution: 'PENDING', initialAssessmentId: null, initialCoverageGroupId: null, quality: 'BELOW_STANDARD' });
        expect(posts.map(post => post.kind)).toEqual(['RECORD', 'ENRICH']);
        expect(posts[0].clientAttemptId).toBe(posts[1].clientAttemptId);
        expect(await prisma.solutionRevision.count({ where: { momentId: fixture.id } })).toBe(1);
        expect((await prisma.trainingMoment.findUniqueOrThrow({ where: { id: fixture.id } })).currentSolutionRevisionId).toBe(fixture.revisionId);
        expect(errors).toEqual([]);
        await test.info().attach('practice-t2-pending-original', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    } finally {
        await page.close();
        await prisma.analyzedGame.delete({ where: { id: fixture.gameId } });
        await prisma.$disconnect();
    }
});
