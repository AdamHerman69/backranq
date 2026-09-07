import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { practicePositionFixture } from '../helpers/practice-position';
import { reviewForPracticeManifest } from '@/lib/training/practiceReview';

it('records contiguous USER step indexes while board plies include the opponent reply', async () => {
    const manifest = practicePositionFixture({ fen: new Chess().fen(), originalMoveUci: 'a2a3', bestMoveUci: 'e2e4',
        continuation: { opponentMoveUci: 'e7e5', userMoveUci: 'g1f3' } });
    const prompt = { id: manifest.momentId, solutionRevisionId: manifest.revisionId, fen: manifest.source.fen,
        sideToMove: 'w', grading: manifest, review: reviewForPracticeManifest({ manifest, provider: 'lichess', playedAt: '2026-01-01T00:00:00.000Z', sourceKinds: [], lessonKinds: [], themes: [] }) };
    const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Chess } from 'chess.js';
        import { usePuzzleSession } from './src/lib/hooks/usePuzzleSession';
        const prompt = ${JSON.stringify(prompt)}; window.events = [];
        function Harness() {
            const session = usePuzzleSession({ initialPrompt: prompt, onCompleted: event => window.events.push(event.request) });
            useEffect(() => { window.move = moveUci => {
                const board = new Chess(session.solveFen); board.move({from:moveUci.slice(0,2),to:moveUci.slice(2,4)});
                return session.submitMove({moveUci,fenAfterMove:board.fen()});
            }; window.reviewSnapshot = {review:session.review, story:session.story, refinement:session.refinement};
                window.showReview = () => session.showReviewPosition('ATTEMPT'); });
            return React.createElement('div', {'data-phase':session.phase, 'data-stage':session.presentation.stage,
                'data-last-move':session.presentation.lastMove ? session.presentation.lastMove.from + session.presentation.lastMove.to : '',
                'data-marker':session.presentation.marker?.grade ?? '', 'data-review':Boolean(session.review), 'data-story':Boolean(session.story),
                'data-fen':session.displayFen});
        }
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
    ` }, bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/bundle.js' ? bundle.outputFiles[0].contents : '<div id="root"></div><script src="/bundle.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No harness address');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.waitForFunction(() => typeof (window as unknown as { move?: unknown }).move === 'function');
        await page.evaluate(() => (window as unknown as { move(move: string): Promise<void> }).move('e2e4'));
        await expect.poll(() => page.locator('[data-phase]').getAttribute('data-phase')).toBe('AWAITING_MOVE');
        expect(await page.locator('[data-stage]').getAttribute('data-stage')).toBe('SETTLED');
        expect(await page.locator('[data-last-move]').getAttribute('data-last-move')).toBe('e7e5');
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('');
        expect(await page.locator('[data-review]').getAttribute('data-review')).toBe('false');
        expect(await page.locator('[data-story]').getAttribute('data-story')).toBe('false');
        await page.evaluate(() => (window as unknown as { move(move: string): Promise<void> }).move('g1f3'));
        await expect.poll(() => page.locator('[data-phase]').getAttribute('data-phase')).toBe('GRADED');
        expect(await page.locator('[data-review]').getAttribute('data-review')).toBe('true');
        const rootAssessment = manifest.assessments.find(a => a.contextId === manifest.source.contextId && a.moveUci === 'e2e4')!;
        const snapshot = await page.evaluate(() => (window as unknown as {reviewSnapshot: {review: {submittedMoveUci: string; bestLineUci: string[]; comparison: {recoveredCp: number}}, story: {segments: Array<{kind: string; movesUci: string[]}>}, refinement?: string}}).reviewSnapshot);
        expect(snapshot.review.submittedMoveUci).toBe('e2e4');
        expect(snapshot.review.bestLineUci).toEqual(['e2e4', 'e7e5', 'g1f3']);
        expect(snapshot.review.comparison.recoveredCp).toBe(rootAssessment.metrics.recoveredCp);
        expect(snapshot.story.segments.find(segment => segment.kind === 'YOUR_MOVE')?.movesUci).toEqual(['e2e4']);
        expect(snapshot.refinement).toBeUndefined();
        await page.evaluate(() => (window as unknown as {showReview(): void}).showReview());
        const reviewedBoard = new Chess(prompt.fen); reviewedBoard.move('e4');
        await expect.poll(() => page.locator('[data-fen]').getAttribute('data-fen')).toBe(reviewedBoard.fen());
        const events = await page.evaluate(() => (window as unknown as { events: Array<{ stepIndex: number; moveUci: string; clientAttemptId: string }> }).events);
        expect(events.map(event => [event.stepIndex, event.moveUci])).toEqual([[0, 'e2e4'], [1, 'g1f3']]);
        expect(events[0].clientAttemptId).toBe(events[1].clientAttemptId);
        expect(errors).toEqual([]);
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 20_000);
