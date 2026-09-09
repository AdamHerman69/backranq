import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';
import { practiceV4Fixture } from '../helpers/practice-v4';

it('records before grading, enriches one move, and ignores rejected work from a previous puzzle', async () => {
    const manifest = practiceV4Fixture();
    manifest.continuation.nodes = [{ id: manifest.source.contextId, contextId: manifest.source.contextId, fen: manifest.source.fen,
        positionHistory: [], trainingSide: 'WHITE', role: 'USER', answerIndex: manifest.rootAnswerIndex }];
    const prompt = { id: 'moment', solutionRevisionId: 'revision', fen: manifest.source.fen, sideToMove: 'w', grading: manifest,
        review: { trainingSide: 'w', originalMoveUci: 'a2a3', submittedMoveUci: null, bestMoveUci: 'e2e4', acceptedMovesUci: ['e2e4', 'd2d4'], acceptedMovesComplete: false,
            bestLineUci: ['e2e4'], scoreAtStart: null, originalDecision: { scoreBefore: null, scoreAfter: null, cpLoss: null, winChanceLoss: null }, comparison: null, sourceKinds: [], lessonKinds: [], themes: [], source: { gameId: 'game', provider: 'CHESS_COM', playedAt: '', decisionPly: 0 } } };
    const bundle = await build({ stdin: { contents: `
        import React, { useEffect } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Chess } from 'chess.js';
        import { usePuzzleSession } from './src/lib/hooks/usePuzzleSession';
        import { StockfishClient } from './src/lib/analysis/stockfishClient';
        const prompt = ${JSON.stringify(prompt)};
        window.events = []; window.order = [];
        requestAnimationFrame(function observeFrame() {
            if (document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'SUBMITTING' && !window.order.includes('ENGINE')) window.pendingPaintBeforeEngine = true;
            if (window.observeKnown && document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'GRADED' && !window.order.includes('ENGINE')) window.knownPaintBeforeEngine = true;
            requestAnimationFrame(observeFrame);
        });
        function Harness() {
            const session = usePuzzleSession({ initialPrompt: prompt, stopEngineOnTerminal: true,
                onCompleted: value => { window.order.push('RECORD'); window.events.push(value.request); },
                onRefined: (_, value) => window.events.push(value) });
            useEffect(() => { window.control = { session,
                move: moveUci => { const chess = new Chess(prompt.fen); chess.move({from: moveUci.slice(0,2),to:moveUci.slice(2,4)}); return session.submitMove({moveUci,fenAfterMove:chess.fen()}); },
                next: () => session.activatePrompt({...prompt,id:'next',solutionRevisionId:'next-revision'}, new StockfishClient()),
                nextRecommended: () => { const grading=structuredClone(prompt.grading); grading.policyId='practice-v5-point-first';
                    grading.rootAnswerIndex.preferredMoveUci='d2d4'; grading.continuation.nodes[0].answerIndex=grading.rootAnswerIndex;
                    session.activatePrompt({...prompt,grading,id:'recommended',solutionRevisionId:'recommended-revision'},new StockfishClient()); } }; });
            return React.createElement('div', {'data-phase':session.phase, 'data-prompt':session.prompt?.solutionRevisionId,
                'data-marker':session.presentation.marker?.grade ?? '', 'data-stage':session.presentation.stage,
                'data-fen':session.displayFen, 'data-refinement':session.refinement ?? '', 'data-hint':session.answerHint ?? '',
                'data-credit':String(session.recommendationCreditRetained), 'data-quality':session.quality});
        }
        createRoot(document.getElementById('root')).render(React.createElement(Harness));
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false,
        define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'controlled-engine', setup(builder) {
            builder.onResolve({ filter: /(^|\/)stockfishClient$/ }, () => ({ path: 'engine', namespace: 'controlled' }));
            builder.onResolve({ filter: /(^|\/)localGrading$/ }, () => ({ path: 'grading', namespace: 'controlled' }));
            builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ loader: 'js', contents: args.path === 'engine' ? `
                export class StockfishClient { constructor(){ this.terminated=false; (window.engines??=[]).push(this); } cancelAll(){} terminate(){this.terminated=true;} getIdentity(){return Promise.resolve({});} }
            ` : `
                export function createLocalAnalysisSession(){return {pool:{},frame:null,referenceMoveUci:null};}
                export function prewarmLocalReference(){return Promise.resolve();}
                export function gradeKnownLocalMove(args){
                    window.knownSession=args.session;
                    if(window.invalidateKnown && args.session)return null;
                    if(args.moveUci!=='d2d4')return null;
                    return {result:{status:'GRADED',quality:'GOOD',tier:null,accepted:true,originalRelation:'BETTER'},source:'PRECOMPUTED',
                        assessment:{...args.manifest.assessments.find(a=>a.moveUci==='d2d4'),tier:null,tierSupport:'NONE'},patch:null,refinementNeeded:true,scoreAfter:null,comparison:null};
                }
                export function gradeUnknownLocalMove(args){ args.engine = typeof args.engine === 'function' ? args.engine() : args.engine; window.order.push('ENGINE'); return new Promise((resolve,reject)=>{window.pending={args,resolve,reject};}); }
                export function localContinuationForMove(){return null;}
                export function practiceScoreToWhite(){return null;}
            ` }));
        } }] });
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/bundle.js' ? bundle.outputFiles[0].contents : '<div id="root"></div><script src="/bundle.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.waitForFunction(() => Boolean((window as unknown as { control?: unknown }).control));
        await page.evaluate(() => { const test = window as unknown as { control: { move(move: string): void } }; void test.control.move('g1f3'); });
        await page.waitForFunction(() => (window as unknown as { pending?: unknown }).pending);
        expect(await page.locator('[data-hint]').getAttribute('data-hint')).toContain('Not among the 3 current engine lines');
        expect(await page.evaluate(() => (window as unknown as { order: string[] }).order)).toEqual(['RECORD', 'ENGINE']);
        expect(await page.evaluate(() => (window as unknown as { pendingPaintBeforeEngine: boolean }).pendingPaintBeforeEngine)).toBe(true);
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('SUBMITTING');
        const pending = await page.evaluate(() => (window as unknown as { events: unknown[] }).events);
        expect(pending).toMatchObject([{ kind: 'RECORD', resolution: 'PENDING', moveUci: 'g1f3', initialAssessmentId: null, initialCoverageGroupId: null }]);
        // Old work rejects after a replacement already owns another engine.
        await page.evaluate(() => { const test = window as unknown as { control: { next(): void }; pending: { reject(error: Error): void }; rejectOld?: (error: Error) => void };
            test.rejectOld = test.pending.reject; test.control.next(); });
        await page.waitForFunction(() => document.querySelector('[data-prompt]')?.getAttribute('data-prompt') === 'next-revision');
        await page.evaluate(() => { const test = window as unknown as { control: { session: { getOrCreateEngine(): void } }; rejectOld(error: Error): void };
            test.control.session.getOrCreateEngine(); test.rejectOld(new Error('old runtime failure')); });
        expect(await page.evaluate(() => (window as unknown as { engines: { terminated: boolean }[] }).engines.at(-1)?.terminated)).toBe(false);
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('READY');
        expect(await page.evaluate(() => (window as unknown as { engines: { terminated: boolean }[] }).engines.map(engine => engine.terminated))).toEqual([true, false]);
        expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events.length)).toBe(1);
        // Failure on the active attempt appends UNAVAILABLE to its RECORD, never another reveal/move.
        await page.evaluate(() => { const test = window as unknown as { control: { move(move: string): void } }; void test.control.move('g1f3'); });
        await page.waitForFunction(() => (window as unknown as { events: unknown[] }).events.length === 2);
        await page.waitForFunction(() => (window as unknown as { order: string[] }).order.filter(item => item === 'ENGINE').length === 2);
        await page.evaluate(() => (window as unknown as { pending: { reject(error: Error): void } }).pending.reject(new Error('offline')));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'REVEALED');
        expect(await page.evaluate(() => (window as unknown as { events: unknown[] }).events)).toMatchObject([
            { kind: 'RECORD' }, { kind: 'RECORD', momentRevisionId: 'next-revision' }, { kind: 'ENRICH', resolution: 'UNAVAILABLE', sequence: 1, supersedesEventId: null },
        ]);
        // Already-supported GOOD must paint before optional tier work too.
        await page.evaluate(() => { const test = window as unknown as { control: { next(): void }; order: string[]; observeKnown: boolean }; test.control.next(); test.order = []; test.observeKnown = true; });
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        await page.evaluate(() => { void (window as unknown as { control: { move(move: string): Promise<void> } }).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as { pending?: { args: { moveUci: string } } }).pending?.args.moveUci === 'd2d4');
        expect(await page.evaluate(() => (window as unknown as { knownPaintBeforeEngine: boolean }).knownPaintBeforeEngine)).toBe(true);
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('GRADED');
        await page.evaluate(() => (window as unknown as { pending: { reject(error: Error): void } }).pending.reject(new Error('Optional detail unavailable')));
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('GRADED');
        // A compatible counterexample withdraws initial quality rather than
        // being presented as mere uncertainty about its finer tier.
        await page.evaluate(() => (window as unknown as {control: {next(): void}}).control.next());
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        const before = await page.evaluate(() => (window as unknown as {events: unknown[]}).events.length);
        await page.evaluate(() => { void (window as unknown as {control: {move(move: string): Promise<void>}}).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as {events: unknown[]}).events.length > 4);
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 2);
        await page.evaluate(() => (window as unknown as {pending: {args: {onUpdate(value: unknown): void}}}).pending.args.onUpdate({kind:'INVALIDATED', evaluation: {
            result: {status:'UNRESOLVED',reason:'UNSTABLE_EVIDENCE'}, invalidatedKnownQuality:true,
            source:'CLIENT_EVALUATED',assessment:null,patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }}));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'REVEALED');
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('');
        expect(await page.evaluate(index => (window as unknown as {events: unknown[]}).events.slice(index), before)).toMatchObject([
            {kind:'RECORD',resolution:'RESOLVED'}, {kind:'ENRICH',resolution:'UNAVAILABLE',sequence:1},
        ]);
        // Next can cancel the still-running detail job only after withdrawal
        // has already been durably emitted for the original attempt.
        await page.evaluate(() => { const test = window as unknown as {control: {next(): void}; pending: {reject(error: Error): void}};
            test.control.next(); test.pending.reject(new Error('cancelled after withdrawal')); });
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        expect(await page.evaluate(index => (window as unknown as {events: unknown[]}).events.length - index, before)).toBe(2);
        // Final completion can supply the second independent converged search
        // without another streaming SUPPORTED callback. Apply that recovery.
        const recoveryStart = await page.evaluate(() => (window as unknown as {events: unknown[]}).events.length);
        await page.evaluate(() => { void (window as unknown as {control: {move(move: string): Promise<void>}}).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 3);
        await page.evaluate(() => (window as unknown as {pending: {args: {onUpdate(value: unknown): void}}}).pending.args.onUpdate({kind:'INVALIDATED', evaluation: {
            result: {status:'UNRESOLVED',reason:'UNSTABLE_EVIDENCE'}, invalidatedKnownQuality:true,
            source:'CLIENT_EVALUATED',assessment:null,patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }}));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'REVEALED');
        await page.evaluate(() => (window as unknown as {pending: {resolve(value: unknown): void}}).pending.resolve({
            result: {status:'GRADED',quality:'GOOD',tier:'STRONG',accepted:true,originalRelation:'BETTER'},
            source:'CLIENT_EVALUATED',assessment:{id:'final-assessment'},patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'GRADED');
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('STRONG');
        const recovery = await page.evaluate(index => (window as unknown as {events: {eventId?: string; supersedesEventId?: string}[]}).events.slice(index), recoveryStart);
        expect(recovery).toMatchObject([{kind:'RECORD'}, {kind:'ENRICH',resolution:'UNAVAILABLE',sequence:1}, {kind:'ENRICH',resolution:'RESOLVED',sequence:2}]);
        expect(recovery[2].supersedesEventId).toBe(recovery[1].eventId);
        expect(await page.locator('[data-refinement]').getAttribute('data-refinement')).toBe('REFINED');
        // Reviewing the decision is a user choice, not something a late detail
        // callback may replace with a marker for the after-move position.
        await page.evaluate(() => (window as unknown as {control: {next(): void}}).control.next());
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        await page.evaluate(() => { void (window as unknown as {control: {move(move: string): Promise<void>}}).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 4);
        await page.evaluate(() => (window as unknown as {control: {session: {showReviewPosition(position: string): void}}}).control.session.showReviewPosition('DECISION'));
        await page.waitForFunction(() => document.querySelector('[data-stage]')?.getAttribute('data-stage') === 'REVIEW_DECISION');
        await page.evaluate(() => (window as unknown as {pending: {resolve(value: unknown): void}}).pending.resolve({
            result: {status:'GRADED',quality:'GOOD',tier:'STRONG',accepted:true,originalRelation:'BETTER'},
            source:'CLIENT_EVALUATED',assessment:{id:'review-assessment'},patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }));
        await page.waitForFunction(() => document.querySelector('[data-refinement]')?.getAttribute('data-refinement') === 'REFINED');
        expect(await page.locator('[data-stage]').getAttribute('data-stage')).toBe('REVIEW_DECISION');
        expect(await page.locator('[data-fen]').getAttribute('data-fen')).toBe(prompt.fen);
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('');
        await page.evaluate(() => (window as unknown as {control: {session: {showReviewPosition(position: string): void}}}).control.session.showReviewPosition('ATTEMPT'));
        await page.waitForFunction(() => document.querySelector('[data-stage]')?.getAttribute('data-stage') === 'REVIEW_ATTEMPT');
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('STRONG');
        // Neutral withdrawal must not erase the earlier supported quality:
        // restoring the opposite verdict explicitly reports a correction.
        await page.evaluate(() => (window as unknown as {control: {next(): void}}).control.next());
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        const correctionStart = await page.evaluate(() => (window as unknown as {events: unknown[]}).events.length);
        await page.evaluate(() => { void (window as unknown as {control: {move(move: string): Promise<void>}}).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 5);
        await page.evaluate(() => (window as unknown as {control: {session: {showReviewPosition(position: string): void}}}).control.session.showReviewPosition('DECISION'));
        await page.waitForFunction(() => document.querySelector('[data-stage]')?.getAttribute('data-stage') === 'REVIEW_DECISION');
        await page.evaluate(() => (window as unknown as {pending: {args: {onUpdate(value: unknown): void}}}).pending.args.onUpdate({kind:'INVALIDATED', evaluation: {
            result: {status:'UNRESOLVED',reason:'UNSTABLE_EVIDENCE'}, invalidatedKnownQuality:true,
            source:'CLIENT_EVALUATED',assessment:null,patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }}));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'REVEALED');
        expect(await page.locator('[data-stage]').getAttribute('data-stage')).toBe('REVIEW_DECISION');
        await page.evaluate(() => (window as unknown as {pending: {resolve(value: unknown): void}}).pending.resolve({
            result: {status:'GRADED',quality:'BELOW_STANDARD',tier:'SUBPAR',accepted:false,originalRelation:'WORSE'},
            source:'CLIENT_EVALUATED',assessment:{id:'corrected-assessment'},patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }));
        await page.waitForFunction(() => document.querySelector('[data-refinement]')?.getAttribute('data-refinement') === 'CORRECTED');
        expect(await page.locator('[data-stage]').getAttribute('data-stage')).toBe('REVIEW_DECISION');
        expect(await page.locator('[data-fen]').getAttribute('data-fen')).toBe(prompt.fen);
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('');
        const correction = await page.evaluate(index => (window as unknown as {events: {eventId?: string; supersedesEventId?: string}[]}).events.slice(index), correctionStart);
        expect(correction).toMatchObject([{kind:'RECORD'}, {kind:'ENRICH',resolution:'UNAVAILABLE',sequence:1}, {kind:'ENRICH',resolution:'RESOLVED',sequence:2}]);
        expect(correction[2].supersedesEventId).toBe(correction[1].eventId);
        // A prior local counter must participate in immediate lookup. The hook
        // records pending instead of briefly restoring the canonical GOOD.
        await page.evaluate(() => (window as unknown as {control: {next(): void}}).control.next());
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        const counterStart = await page.evaluate(() => (window as unknown as {events: unknown[]}).events.length);
        await page.evaluate(() => {
            const test = window as unknown as {invalidateKnown: boolean; control: {move(move: string): Promise<void>}};
            test.invalidateKnown = true; void test.control.move('d2d4');
        });
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 6);
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('SUBMITTING');
        expect(await page.evaluate(index => (window as unknown as {events: unknown[]}).events.slice(index), counterStart)).toMatchObject([
            {kind:'RECORD',resolution:'PENDING',initialAssessmentId:null,initialCoverageGroupId:null},
        ]);
        expect(await page.evaluate(() => {
            const test = window as unknown as {knownSession: unknown; pending: {args: {session: unknown}}};
            return test.knownSession === test.pending.args.session;
        })).toBe(true);
        await page.evaluate(() => (window as unknown as {pending: {reject(error: Error): void}}).pending.reject(new Error('counter remains unresolved')));
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'REVEALED');
        // Analytical corrections remain recorded, but following the served v5
        // recommendation cannot turn an accepted attempt into a penalty.
        await page.evaluate(() => {
            const test = window as unknown as {invalidateKnown: boolean; control: {nextRecommended(): void}};
            test.invalidateKnown = false; test.control.nextRecommended();
        });
        await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
        const protectedStart = await page.evaluate(() => (window as unknown as {events: unknown[]}).events.length);
        await page.evaluate(() => { void (window as unknown as {control: {move(move: string): Promise<void>}}).control.move('d2d4'); });
        await page.waitForFunction(() => (window as unknown as {order: string[]}).order.filter(item => item === 'ENGINE').length === 7);
        await page.evaluate(() => (window as unknown as {pending: {args: {onUpdate(value: unknown): void}}}).pending.args.onUpdate({kind:'INVALIDATED', evaluation: {
            result: {status:'UNRESOLVED',reason:'UNSTABLE_EVIDENCE'}, invalidatedKnownQuality:true,
            source:'CLIENT_EVALUATED',assessment:null,patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }}));
        await page.waitForFunction(() => document.querySelector('[data-credit]')?.getAttribute('data-credit') === 'true');
        expect(await page.locator('[data-phase]').getAttribute('data-phase')).toBe('GRADED');
        await page.evaluate(() => (window as unknown as {pending: {resolve(value: unknown): void}}).pending.resolve({
            result: {status:'GRADED',quality:'BELOW_STANDARD',tier:'SUBPAR',accepted:false,originalRelation:'WORSE'},
            source:'CLIENT_EVALUATED',assessment:{id:'changed-recommendation',quality:'BELOW_STANDARD'},patch:null,refinementNeeded:false,scoreAfter:null,comparison:null,
        }));
        await page.waitForFunction(() => document.querySelector('[data-refinement]')?.getAttribute('data-refinement') === 'REFINED');
        expect(await page.locator('[data-quality]').getAttribute('data-quality')).toBe('GOOD');
        expect(await page.locator('[data-marker]').getAttribute('data-marker')).toBe('GOOD');
        expect(await page.evaluate(index => (window as unknown as {events: unknown[]}).events.slice(index), protectedStart)).toMatchObject([
            {kind:'RECORD',resolution:'RESOLVED'}, {kind:'ENRICH',resolution:'UNAVAILABLE'}, {kind:'ENRICH',resolution:'RESOLVED',assessmentId:'changed-recommendation'},
        ]);
        expect(errors).toEqual([]);
    } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 20_000);
