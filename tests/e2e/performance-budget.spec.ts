import { expect, test } from '@playwright/test';
import { gzipSync } from 'node:zlib';

import { waitForBoard } from './support/board';
import { E2E_GAMES } from './support/fixtures';

test.describe('performance budgets', () => {
    test('keeps one Practice position compact and immediately usable', async ({
        page,
    }, testInfo) => {
        test.setTimeout(90_000);
        await installPerformanceProbe(page);
        const stockfishRequests: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/vendor/stockfish/')) {
                stockfishRequests.push(request.url());
            }
        });
        const practiceUrl =
            `/practice?mode=new&gameId=${E2E_GAMES.standard}`;
        const navigationResponse = await page.goto(practiceUrl);
        expect(navigationResponse?.ok()).toBe(true);
        const documentBody = await navigationResponse!.body();
        const documentBytes = documentBody.byteLength;
        const documentGzipBytes = gzipSync(documentBody).byteLength;
        await waitForBoard(page);
        const coldInteractionReadyMs = await markBoardInteractionReady(page);
        const coldNavigation = await readPerformanceProbe(page);
        expect(coldNavigation.preparingSeen).toBe(false);
        expect(coldNavigation.boardPaintMs).not.toBeNull();

        const warmDocumentBoardPaintSamplesMs: number[] = [];
        const warmDocumentInteractionSamplesMs: number[] = [];
        for (let sample = 0; sample < 20; sample += 1) {
            const sampledNavigation = await page.goto(practiceUrl);
            expect(sampledNavigation?.ok()).toBe(true);
            await waitForBoard(page);
            warmDocumentInteractionSamplesMs.push(
                await markBoardInteractionReady(page)
            );
            const probe = await readPerformanceProbe(page);
            expect(probe.preparingSeen).toBe(false);
            expect(probe.shellMissing).toBe(false);
            expect(probe.boardPaintMs).not.toBeNull();
            warmDocumentBoardPaintSamplesMs.push(probe.boardPaintMs!);
        }
        const orderedDocumentSamples = [
            ...warmDocumentBoardPaintSamplesMs,
        ].sort((left, right) => left - right);
        const documentP75Ms = percentile(orderedDocumentSamples, 0.75);
        const documentP95Ms = percentile(orderedDocumentSamples, 0.95);
        const orderedDocumentInteractionSamples = [
            ...warmDocumentInteractionSamplesMs,
        ].sort((left, right) => left - right);
        const documentInteractionP75Ms = percentile(
            orderedDocumentInteractionSamples,
            0.75
        );
        const documentInteractionP95Ms = percentile(
            orderedDocumentInteractionSamples,
            0.95
        );

        const warmFeedSamplesMs: number[] = [];
        const feedStartedAt = performance.now();
        const response = await page.request.get(
            `/api/training/feed?limit=1&mode=new&gameId=${E2E_GAMES.standard}`
        );
        const firstApiAfterNavigationMs = performance.now() - feedStartedAt;
        expect(response.ok()).toBe(true);
        const body = await response.text();
        const json = JSON.parse(body) as {
            items?: unknown[];
        };
        expect(json.items).toHaveLength(1);
        const promptBytes = Buffer.byteLength(
            JSON.stringify(json.items![0]),
            'utf8'
        );
        const responseBytes = Buffer.byteLength(body, 'utf8');
        const promptGzipBytes = gzipSync(
            Buffer.from(JSON.stringify(json.items![0]))
        ).byteLength;
        const responseGzipBytes = gzipSync(Buffer.from(body)).byteLength;
        const operationCount = Number(
            response.headers()['x-backranq-db-operation-count'] ?? 'NaN'
        );
        for (let sample = 0; sample < 20; sample += 1) {
            const startedAt = performance.now();
            const sampledResponse = await page.request.get(
                `/api/training/feed?limit=1&mode=new&gameId=${E2E_GAMES.standard}`
            );
            expect(sampledResponse.ok()).toBe(true);
            warmFeedSamplesMs.push(performance.now() - startedAt);
        }
        const orderedFeedSamples = [...warmFeedSamplesMs].sort(
            (left, right) => left - right
        );
        const feedP50Ms = percentile(orderedFeedSamples, 0.5);
        const feedP95Ms = percentile(orderedFeedSamples, 0.95);

        const homeToPracticeBoardPaintSamplesMs: number[] = [];
        const homeToPracticeInteractionSamplesMs: number[] = [];
        for (let sample = 0; sample < 20; sample += 1) {
            await page.goto('/home');
            await expect(
                page.getByRole('link', { name: 'Practice now' })
            ).toBeVisible();
            await resetPerformanceProbeForTransition(page);
            await page.getByRole('link', { name: 'Practice now' }).click();
            await waitForBoard(page);
            const interactionReadyMs = await markBoardInteractionReady(page);
            const probe = await readPerformanceProbe(page);
            expect(probe.preparingSeen).toBe(false);
            expect(probe.shellMissing).toBe(false);
            expect(probe.boardPaintMs).not.toBeNull();
            expect(probe.transitionStartedAt).not.toBeNull();
            homeToPracticeBoardPaintSamplesMs.push(
                probe.boardPaintMs! - probe.transitionStartedAt!
            );
            homeToPracticeInteractionSamplesMs.push(
                interactionReadyMs - probe.transitionStartedAt!
            );
        }
        const orderedHomeToPracticeSamples = [
            ...homeToPracticeBoardPaintSamplesMs,
        ].sort((left, right) => left - right);
        const homeToPracticeP75Ms = percentile(
            orderedHomeToPracticeSamples,
            0.75
        );
        const homeToPracticeP95Ms = percentile(
            orderedHomeToPracticeSamples,
            0.95
        );
        const orderedHomeToPracticeInteractionSamples = [
            ...homeToPracticeInteractionSamplesMs,
        ].sort((left, right) => left - right);
        const homeToPracticeInteractionP75Ms = percentile(
            orderedHomeToPracticeInteractionSamples,
            0.75
        );
        const homeToPracticeInteractionP95Ms = percentile(
            orderedHomeToPracticeInteractionSamples,
            0.95
        );

        const metrics = {
            firstDocumentBoardPaintMs: rounded(
                coldNavigation.boardPaintMs!
            ),
            firstDocumentInteractionReadyMs: rounded(
                coldInteractionReadyMs
            ),
            warmDocumentSampleCount:
                warmDocumentBoardPaintSamplesMs.length,
            warmDocumentBoardPaintSamplesMs:
                warmDocumentBoardPaintSamplesMs.map(rounded),
            documentP75Ms: rounded(documentP75Ms),
            documentP95Ms: rounded(documentP95Ms),
            warmDocumentInteractionSamplesMs:
                warmDocumentInteractionSamplesMs.map(rounded),
            documentInteractionP75Ms: rounded(
                documentInteractionP75Ms
            ),
            documentInteractionP95Ms: rounded(
                documentInteractionP95Ms
            ),
            homeToPracticeSampleCount:
                homeToPracticeBoardPaintSamplesMs.length,
            homeToPracticeBoardPaintSamplesMs:
                homeToPracticeBoardPaintSamplesMs.map(rounded),
            homeToPracticeP75Ms: rounded(homeToPracticeP75Ms),
            homeToPracticeP95Ms: rounded(homeToPracticeP95Ms),
            homeToPracticeInteractionSamplesMs:
                homeToPracticeInteractionSamplesMs.map(rounded),
            homeToPracticeInteractionP75Ms: rounded(
                homeToPracticeInteractionP75Ms
            ),
            homeToPracticeInteractionP95Ms: rounded(
                homeToPracticeInteractionP95Ms
            ),
            firstApiAfterNavigationMs: rounded(
                firstApiAfterNavigationMs
            ),
            warmFeedSampleCount: warmFeedSamplesMs.length,
            warmFeedSamplesMs: warmFeedSamplesMs.map(rounded),
            feedP50Ms: rounded(feedP50Ms),
            feedP95Ms: rounded(feedP95Ms),
            promptBytes,
            promptGzipBytes,
            responseBytes,
            responseGzipBytes,
            documentBytes,
            documentGzipBytes,
            operationCount,
            stockfishPrewarmRequestCount: stockfishRequests.length,
        };

        console.info(
            `Practice performance: ${JSON.stringify(metrics)}`
        );

        await testInfo.attach('practice-performance.json', {
            contentType: 'application/json',
            body: Buffer.from(
                JSON.stringify(metrics, null, 2)
            ),
        });
        expect(promptBytes).toBeLessThan(64 * 1024);
        expect(promptGzipBytes).toBeLessThan(16 * 1024);
        expect(responseBytes).toBeLessThan(80 * 1024);
        expect(responseGzipBytes).toBeLessThan(20 * 1024);
        expect(operationCount).toBeGreaterThan(0);
        expect(operationCount).toBeLessThanOrEqual(10);
        expect(coldNavigation.boardPaintMs!).toBeLessThan(3_000);
        expect(coldInteractionReadyMs).toBeLessThan(3_000);
        expect(warmDocumentBoardPaintSamplesMs).toHaveLength(20);
        expect(documentP75Ms).toBeLessThan(500);
        expect(documentP95Ms).toBeLessThan(1_000);
        expect(warmDocumentInteractionSamplesMs).toHaveLength(20);
        expect(documentInteractionP75Ms).toBeLessThan(750);
        expect(documentInteractionP95Ms).toBeLessThan(1_250);
        expect(homeToPracticeBoardPaintSamplesMs).toHaveLength(20);
        expect(homeToPracticeP75Ms).toBeLessThan(500);
        expect(homeToPracticeP95Ms).toBeLessThan(1_000);
        expect(homeToPracticeInteractionSamplesMs).toHaveLength(20);
        expect(homeToPracticeInteractionP75Ms).toBeLessThan(750);
        expect(homeToPracticeInteractionP95Ms).toBeLessThan(1_250);
        expect(warmFeedSamplesMs).toHaveLength(20);
        expect(feedP95Ms).toBeLessThan(1_000);
    });

    test('keeps browser Practice navigation usable on a constrained connection', async ({
        page,
    }, testInfo) => {
        test.setTimeout(30_000);
        await installPerformanceProbe(page);
        const stockfishRequests: string[] = [];
        const practiceBrowserRequests: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/vendor/stockfish/')) {
                stockfishRequests.push(request.url());
            }
            if (
                request.url().includes('/practice') &&
                request.resourceType() !== 'document'
            ) {
                practiceBrowserRequests.push(request.url());
            }
        });

        await page.goto('/home');
        await expect(
            page.getByRole('link', { name: 'Practice now' })
        ).toBeVisible();

        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 150,
            downloadThroughput: 200_000,
            uploadThroughput: 94_000,
        });
        await resetPerformanceProbeForTransition(page);
        await page.getByRole('link', { name: 'Practice now' }).click();
        await waitForBoard(page);
        const interactionReadyMs = await markBoardInteractionReady(page);
        const probe = await readPerformanceProbe(page);
        await cdp.send('Network.disable');

        expect(probe.boardPaintMs).not.toBeNull();
        expect(probe.transitionStartedAt).not.toBeNull();
        expect(probe.shellMissing).toBe(false);
        const metrics = {
            profile: {
                latencyMs: 150,
                downloadBytesPerSecond: 200_000,
                uploadBytesPerSecond: 94_000,
            },
            boardPaintMs: rounded(
                probe.boardPaintMs! - probe.transitionStartedAt!
            ),
            interactionReadyMs: rounded(
                interactionReadyMs - probe.transitionStartedAt!
            ),
            preparingSeen: probe.preparingSeen,
            browserPracticeRequestCount: practiceBrowserRequests.length,
            stockfishPrewarmRequestCount: stockfishRequests.length,
        };
        await testInfo.attach('practice-constrained-network.json', {
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(metrics, null, 2)),
        });

        expect(metrics.boardPaintMs).toBeLessThan(6_000);
        expect(metrics.interactionReadyMs).toBeLessThan(6_000);
        expect(metrics.preparingSeen).toBe(false);
        expect(practiceBrowserRequests.length).toBeGreaterThan(0);
    });
});

async function markBoardInteractionReady(
    page: import('@playwright/test').Page
) {
    return page.evaluate(
        () =>
            new Promise<number>((resolve, reject) => {
                const board = document.querySelector('[data-board-stage]');
                const target = document.querySelector(
                    '[data-square="g1"]'
                );
                if (
                    !(board instanceof HTMLElement) ||
                    !(target instanceof HTMLElement)
                ) {
                    reject(new Error('Interactive board was not mounted'));
                    return;
                }
                const finishIfSelected = () => {
                    if (
                        board.dataset.boardSelectedSquare !== 'g1'
                    ) {
                        return false;
                    }
                    observer.disconnect();
                    clearTimeout(timeoutId);
                    resolve(performance.now());
                    return true;
                };
                const observer = new MutationObserver(finishIfSelected);
                const timeoutId = window.setTimeout(() => {
                    observer.disconnect();
                    reject(new Error('Board did not accept an interaction'));
                }, 3_000);
                observer.observe(board, {
                    attributes: true,
                    attributeFilter: ['data-board-selected-square'],
                });
                target.click();
                finishIfSelected();
            })
    );
}

type PerformanceProbe = {
    preparingSeen: boolean;
    shellMissing: boolean;
    boardPaintMs: number | null;
    transitionStartedAt: number | null;
    transitionArmed: boolean;
};

async function installPerformanceProbe(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        const scopedWindow = window as typeof window & {
            __backranqPerformanceProbe?: PerformanceProbe;
        };
        const probe: PerformanceProbe = {
            preparingSeen: false,
            shellMissing: false,
            boardPaintMs: null,
            transitionStartedAt: null,
            transitionArmed: false,
        };
        scopedWindow.__backranqPerformanceProbe = probe;
        document.addEventListener(
            'click',
            (event) => {
                if (!probe.transitionArmed) return;
                const link =
                    event.target instanceof Element
                        ? event.target.closest('a[href]')
                        : null;
                const href = link?.getAttribute('href') ?? '';
                if (!href.startsWith('/practice')) return;
                probe.transitionStartedAt = performance.now();
                probe.transitionArmed = false;
            },
            { capture: true }
        );
        let boardFramePending = false;
        const scan = () => {
            const loadingLabels = [
                'Preparing your positions…',
                'Preparing your practice position',
                'Preparing Backranq',
                'Loading chessboard',
            ];
            const loadingStatusSeen = Array.from(
                document.querySelectorAll('[role="status"]')
            ).some((element) => {
                const accessibleText = [
                    element.getAttribute('aria-label') ?? '',
                    element.textContent ?? '',
                ].join(' ');
                return loadingLabels.some((label) =>
                    accessibleText.includes(label)
                );
            });
            if (
                loadingStatusSeen ||
                loadingLabels.some((label) =>
                    document.body?.innerText.includes(label)
                )
            ) {
                probe.preparingSeen = true;
            }
            if (
                probe.transitionStartedAt !== null &&
                !document.querySelector('[data-app-shell]')
            ) {
                probe.shellMissing = true;
            }
            if (probe.boardPaintMs !== null || boardFramePending) return;
            const square = document.querySelector('[data-square="e4"]');
            if (!(square instanceof HTMLElement)) return;
            const bounds = square.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return;
            boardFramePending = true;
            requestAnimationFrame(() => {
                boardFramePending = false;
                const paintedBounds = square.getBoundingClientRect();
                if (
                    probe.boardPaintMs === null &&
                    paintedBounds.width > 0 &&
                    paintedBounds.height > 0
                ) {
                    probe.boardPaintMs = performance.now();
                }
            });
        };
        new MutationObserver(scan).observe(document, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['aria-label', 'role'],
        });
        scan();
    });
}

async function resetPerformanceProbeForTransition(
    page: import('@playwright/test').Page
) {
    await page.evaluate(() => {
        const probe = (
            window as typeof window & {
                __backranqPerformanceProbe?: PerformanceProbe;
            }
        ).__backranqPerformanceProbe;
        if (!probe) throw new Error('Performance probe was not installed');
        probe.preparingSeen = false;
        probe.shellMissing = false;
        probe.boardPaintMs = null;
        probe.transitionStartedAt = null;
        probe.transitionArmed = true;
    });
}

async function readPerformanceProbe(
    page: import('@playwright/test').Page
): Promise<PerformanceProbe> {
    return page.evaluate(() => {
        const probe = (
            window as typeof window & {
                __backranqPerformanceProbe?: PerformanceProbe;
            }
        ).__backranqPerformanceProbe;
        if (!probe) throw new Error('Performance probe was not installed');
        return { ...probe };
    });
}

function percentile(ordered: readonly number[], quantile: number) {
    if (ordered.length === 0) return Number.NaN;
    const index = Math.min(
        ordered.length - 1,
        Math.ceil(ordered.length * quantile) - 1
    );
    return ordered[index]!;
}

function rounded(value: number) {
    return Math.round(value * 100) / 100;
}
