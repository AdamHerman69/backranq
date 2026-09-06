import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { expect, it } from 'vitest';

it.skipIf(process.env.RUN_PUZZLE_SESSION_BROWSER_RACE !== '1')('a rejected old refinement cannot terminate the engine of a newly activated public puzzle', async () => {
    const bundle = await build({
        stdin: {
            contents: `
                import React, { useEffect, useState } from 'react';
                import { createRoot } from 'react-dom/client';
                import { usePublicPuzzleSession } from './src/lib/hooks/usePublicPuzzleSession';
                import { WARMUP_PUZZLE } from './src/lib/onboarding/warmupPuzzle';
                function Harness() {
                    const [prompt, setPrompt] = useState(WARMUP_PUZZLE.prompt);
                    const session = usePublicPuzzleSession(prompt);
                    useEffect(() => {
                        window.testControl = { session, nextPrompt: () => setPrompt({ ...WARMUP_PUZZLE.prompt,
                            id: 'new-puzzle', solutionRevisionId: 'new-revision' }) };
                    });
                    return React.createElement('div', { 'data-prompt': session.prompt?.solutionRevisionId ?? '' });
                }
                createRoot(document.getElementById('root')).render(React.createElement(Harness));
            `,
            resolveDir: process.cwd(), loader: 'tsx',
        },
        bundle: true, platform: 'browser', format: 'iife', write: false,
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [{
            name: 'controlled-refinement',
            setup(builder) {
                builder.onResolve({ filter: /(^|\/)stockfishClient$/ }, () => ({ path: 'engine', namespace: 'controlled' }));
                builder.onResolve({ filter: /(^|\/)localGrading$/ }, () => ({ path: 'grading', namespace: 'controlled' }));
                builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({
                    loader: 'js',
                    contents: args.path === 'engine' ? `
                        export class StockfishClient {
                            constructor() { this.terminated = false; (window.testEngines ??= []).push(this); }
                            cancelAll() {}
                            terminate() { this.terminated = true; }
                            getIdentity() { return Promise.resolve({}); }
                        }
                    ` : `
                        export function gradeKnownLocalMove() {
                            return { result: { status: 'GRADED', grade: 'DIFFERENT_MISTAKE', accepted: false },
                                source: 'PRECOMPUTED', scoreAfter: null, comparison: null, evidence: {}, refinementNeeded: true };
                        }
                        export function gradeUnknownLocalMove() {
                            return new Promise((resolve, reject) => { window.rejectOldRefinement = reject; });
                        }
                        export function aggregateTrainingGrade(grades) { return grades[0]; }
                        export function localContinuationForMove() { return null; }
                    `,
                }));
            },
        }],
        absWorkingDir: path.resolve('.'),
    });
    const server = createServer((request, response) => {
        response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/bundle.js' ? bundle.outputFiles[0]!.contents : '<div id="root"></div><script src="/bundle.js"></script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Harness server did not bind');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ reducedMotion: 'reduce' });
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.waitForFunction(() => Boolean((window as unknown as { testControl?: unknown }).testControl));
        await page.evaluate(() => {
            const control = (window as unknown as { testControl: { session: { submitMove: (move: { moveUci: string; fenAfterMove: string }) => Promise<void> } }; oldSubmission?: Promise<void> });
            control.oldSubmission = control.testControl.session.submitMove({ moveUci: 'f7e7', fenAfterMove: '7k/4Q3/6K1/8/8/8/8/8 b - - 1 1' });
        });
        await page.waitForFunction(() => typeof (window as unknown as { rejectOldRefinement?: unknown }).rejectOldRefinement === 'function');
        await page.evaluate(() => {
            (window as unknown as { testControl: { nextPrompt: () => void } }).testControl.nextPrompt();
        });
        await page.waitForFunction(() => document.querySelector('[data-prompt]')?.getAttribute('data-prompt') === 'new-revision');
        const result = await page.evaluate(async () => {
            const state = window as unknown as {
                testControl: { session: { getOrCreateEngine: () => { terminated: boolean } } };
                testEngines: Array<{ terminated: boolean }>;
                rejectOldRefinement: (error: Error) => void;
                oldSubmission: Promise<void>;
            };
            const fresh = state.testControl.session.getOrCreateEngine();
            state.rejectOldRefinement(new Error('Cancelled old engine refinement'));
            await state.oldSubmission;
            return { count: state.testEngines.length, oldTerminated: state.testEngines[0]!.terminated,
                freshTerminated: fresh.terminated };
        });
        expect(result).toEqual({ count: 2, oldTerminated: true, freshTerminated: false });
    } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}, 20_000);
