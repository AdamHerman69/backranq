import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, devices } from '@playwright/test';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const input = path.resolve(option('--input', 'artifacts/practice-v4-audit'));
const output = path.resolve(option('--output', 'artifacts/practice-feedback-benchmark.json'));
const buildOnly = argv.includes('--build-only');
const sessionMode = option('--session-mode', 'independent');
if (!['independent', 'shared-stress'].includes(sessionMode)) throw new Error('--session-mode must be independent or shared-stress');
const modes = option('--mode', 'both') === 'both' ? ['desktop', 'mobile-cpu4'] : [option('--mode', 'desktop')];
if (modes.some(mode => !['desktop', 'mobile-cpu4'].includes(mode))) throw new Error('--mode must be desktop, mobile-cpu4 or both');
const limit = Number(option('--limit', Infinity));
if (!(limit > 0)) throw new Error('--limit must be positive');
const hash = value => createHash('sha256').update(value).digest('hex');
const stat = await fs.stat(input);
const files = stat.isDirectory() ? (await fs.readdir(input)).filter(file => file.endsWith('.json') && file !== 'summary.json').sort().map(file => path.join(input, file)) : [input];
const manifests = new Map();
function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.contractVersion === 4 && value.source && value.rootAnswerIndex && value.evidence) {
        manifests.set(`${value.revisionId}:${value.semanticHash}`, value); return;
    }
    for (const child of Object.values(value)) collect(child);
}
const sourceFiles = [];
for (const file of files) { const body = await fs.readFile(file, 'utf8'); collect(JSON.parse(body)); sourceFiles.push({ path: path.relative(process.cwd(), file), sha256: hash(body) }); }
const corpus = [...manifests.values()].slice(0, limit);
if (!corpus.length) throw new Error('Input contains no v4 PracticeMomentRevision manifests; benchmark refused an empty corpus');

// Actual browser grading, policy, planner and Stockfish bridge. The deliberately
// tiny DOM below measures feedback scheduling, not the complete React board.
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import { StockfishClient } from './src/lib/analysis/stockfishClient';
import { AnalysisWorkPlanner } from './src/lib/analysis/analysisWorkPlanner';
import { createLocalAnalysisSession, gradeKnownLocalMove, gradeUnknownLocalMove } from './src/lib/training/localGrading';
import { parsePracticeMomentRevision, validatePracticeEvaluationPatch } from './src/lib/training/practiceContract';
import { lookupAnswer } from './src/lib/training/answerIndex';
import { toleranceCp } from './src/lib/training/assessmentPolicy';
const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))));
const badge = document.getElementById('feedback');
function selectMoves(manifest) {
    const index = manifest.rootAnswerIndex;
    const legal = [...index.legalMovesUci].sort();
    const classified = legal.map(move => ({ move, lookup: lookupAnswer(index, move, manifest.assessments, manifest.coverageGroups) }));
    const selected = new Map();
    const add = (move, stratum) => { if (move && !selected.has(move) && selected.size < 10) selected.set(move, { move, stratum }); };
    add(index.preferredMoveUci, 'KNOWN_GOOD');
    classified.filter(item => item.lookup.quality === 'GOOD').slice(0, 2).forEach(item => add(item.move, 'KNOWN_GOOD'));
    add(manifest.source.originalMoveUci, 'ORIGINAL');
    classified.filter(item => item.lookup.quality === 'BELOW_STANDARD').slice(0, 2).forEach(item => add(item.move, 'KNOWN_BELOW_STANDARD'));
    const reference = manifest.assessments.find(a => a.id === manifest.frames.find(f => f.id === index.frameId)?.referenceAssessmentId);
    const threshold = reference?.score?.kind === 'CP' ? toleranceCp(reference.score.cp, manifest.policySnapshot) : null;
    if (threshold !== null) manifest.assessments.filter(a => a.contextId === index.contextId && a.metrics.lossCp !== null)
        .sort((a, b) => Math.abs(a.metrics.lossCp - threshold) - Math.abs(b.metrics.lossCp - threshold) || a.moveUci.localeCompare(b.moveUci))
        .slice(0, 2).forEach(a => add(a.moveUci, 'NEAREST_KNOWN_BOUNDARY'));
    const unknown = classified.filter(item => item.lookup.kind === 'PENDING');
    // Evenly spaced deterministic unknowns, avoiding an opening-file-only sample.
    for (let i = 0; i < unknown.length; i++) add(unknown[Math.floor(i * unknown.length / Math.min(unknown.length, 10)) % unknown.length]?.move, 'UNKNOWN');
    for (const move of legal) add(move, 'OTHER_LEGAL');
    return [...selected.values()];
}
window.runPosition = async raw => {
    const manifest = parsePracticeMomentRevision(raw);
    const source = manifest.source;
    const node = { id: source.contextId, contextId: source.contextId, fen: source.fen, positionHistory: source.positionHistory,
        trainingSide: source.trainingSide, role: 'USER', answerIndex: manifest.rootAnswerIndex, ply: 0 };
    const selected = selectMoves(manifest);
    let sharedEngine = null;
    const sharedSession = createLocalAnalysisSession();
    const rows = [];
    try {
        for (const { move, stratum } of selected) {
            // A hypothetical alternative is a new attempt. Retaining all prior
            // alternatives is an explicit stress scenario, not ordinary UX.
            const session = ${JSON.stringify(sessionMode)} === 'shared-stress' ? sharedSession : createLocalAnalysisSession();
            const lookupStarted = performance.now();
            const known = gradeKnownLocalMove({ manifest, node, moveUci: move, session });
            const lookupMs = performance.now() - lookupStarted;
            const needsDetail = Boolean(known && (!known.assessment || known.assessment.tierSupport !== 'SUPPORTED'));
            let engine = null; let identity = null; let coldStartupMs = null; let startupError = null;
            if (!known || needsDetail) {
                const startupStarted = performance.now(); let startupTimer;
                const newlyCreated = ${JSON.stringify(sessionMode)} !== 'shared-stress' || !sharedEngine;
                engine = ${JSON.stringify(sessionMode)} === 'shared-stress' ? sharedEngine ??= new StockfishClient() : new StockfishClient();
                try { identity = await Promise.race([engine.getIdentity(), new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Cold startup exceeded 15s')), 15_000); })]); }
                catch (error) { startupError = String(error); engine.terminate(); if (sharedEngine === engine) sharedEngine = null; engine = null; }
                finally { clearTimeout(startupTimer); }
                if (newlyCreated) coldStartupMs = performance.now() - startupStarted;
            }
            // Only initialized, choice-fresh workers enter the warm grading clock.
            const started = performance.now() - lookupMs;
            badge.textContent = known ? known.result.quality : 'PENDING';
            const paintPromise = paint().then(time => time - started);
            let firstLiveMs = null; let supportedQualityMs = known ? lookupMs : null;
            let firstSupportedQuality = known?.result.quality ?? null;
            let knownQualityInvalidated = false;
            let result = known; let error = startupError; let patchValidation = null;
            const planner = new AnalysisWorkPlanner({ maxNodes: needsDetail ? 200_000 : 1_500_000, maxWallMs: needsDetail ? 2_000 : 8_000 });
            if ((!known || needsDetail) && engine) {
                try {
                    await paintPromise;
                    result = await gradeUnknownLocalMove({ manifest, node, moveUci: move, engine, session, planner,
                        refine: needsDetail, attemptId: 'benchmark:' + move,
                        retryEngine: () => {
                            engine.terminate(); engine = new StockfishClient();
                            if (${JSON.stringify(sessionMode)} === 'shared-stress') sharedEngine = engine;
                            return engine;
                        },
                        onUpdate(update) {
                            if (update.kind === 'LIVE') { firstLiveMs ??= performance.now() - started; badge.dataset.liveDepth = String(update.depth); }
                            if (update.kind === 'INVALIDATED') { knownQualityInvalidated = true; badge.textContent = 'PENDING'; }
                            if (update.kind === 'SUPPORTED') {
                                supportedQualityMs ??= performance.now() - started;
                                firstSupportedQuality ??= update.evaluation.result.quality;
                                badge.textContent = update.evaluation.result.quality;
                            }
                        } });
                    if (result?.result.status === 'GRADED') { supportedQualityMs ??= performance.now() - started; firstSupportedQuality ??= result.result.quality; }
                    if (result?.patch) { const validated = validatePracticeEvaluationPatch(manifest, result.patch); patchValidation = { success: validated.success, ...(!validated.success ? { error: validated.issues.join('; ') } : {}) }; }
                } catch (caught) { error = String(caught); }
                finally { if (${JSON.stringify(sessionMode)} !== 'shared-stress') engine.terminate(); }
            }
            const initialHarnessPaintMs = await paintPromise;
            const report = planner.report();
            const final = result?.result.status === 'GRADED' ? result.result
                : !knownQualityInvalidated && !result?.invalidatedKnownQuality && known?.result.status === 'GRADED' ? known.result : null;
            const totalMs = performance.now() - started;
            const runtimeAssessment = structuredClone(result?.assessment ?? null);
            const runtimePatch = structuredClone(result?.patch ?? null);
            rows.push({ move, stratum, coldStartupMs, startupError, engineIdentity: identity,
                runtimeAssessment, runtimePatch, runtimePatchBytes: runtimePatch ? new TextEncoder().encode(JSON.stringify(runtimePatch)).length : 0,
                initialQuality: known?.result.quality ?? 'UNKNOWN', initialTier: known?.result.tier ?? null,
                lookupMs, initialHarnessPaintMs, firstLiveMs, supportedQualityMs, firstSupportedQuality,
                finalQuality: final?.quality ?? 'UNKNOWN', finalTier: final?.tier ?? null,
                totalMs, detailRequested: needsDetail,
                knownQualityInvalidated,
                unresolved: final === null, unresolvedReason: result?.result.status === 'UNRESOLVED' ? result.result.reason : null,
                timedOut: planner.remainingWallMs <= 0 || report.jobs.some(job => job.status === 'BUDGET_EXHAUSTED'),
                nodeBudgetExhausted: planner.remainingNodes < 25_000,
                error, patchValidation, planner: report });
        }
    } finally { sharedEngine?.terminate(); }
    return { revisionId: manifest.revisionId, semanticHash: manifest.semanticHash, legalMoves: manifest.rootAnswerIndex.legalMovesUci.length,
        selectedMoves: selected, rows,
        browser: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null } };
};
` }, bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
if (buildOnly) { console.log(JSON.stringify({ built: true, bundleBytes: bundle.outputFiles[0].contents.length, corpusMoments: corpus.length })); process.exit(0); }
const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Practice feedback benchmark</title><output id="feedback" aria-live="polite">READY</output><script src="/bundle.js"></script>'); return; }
    if (pathname === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
    if (!/^\/vendor\/stockfish\/[a-zA-Z0-9._-]+$/.test(pathname)) { response.writeHead(404).end(); return; }
    try { const bytes = await fs.readFile(path.join(process.cwd(), 'public', pathname)); response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); response.end(bytes); }
    catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
const percentile = (values, p) => { const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null; };
const metric = values => ({ count: values.filter(value => typeof value === 'number' && Number.isFinite(value)).length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
const report = { version: 6, sessionMode,
    localEngineProtocol: sessionMode === 'independent' ? 'FRESH_ENGINE_AND_SESSION_PER_ANSWER' : 'SHARED_ENGINE_TT_AND_SESSION_ORDER_DEPENDENT', startedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceTreeDiffSha256: hash(execFileSync('git', ['diff', '--', 'src', 'public/vendor/stockfish', 'scripts/benchmark-practice-feedback.mjs'], { maxBuffer: 32 * 1024 * 1024 })),
    bundleSha256: hash(bundle.outputFiles[0].contents), corpusSha256: hash(JSON.stringify(corpus)), sourceFiles,
    hardware: { platform: os.platform(), arch: os.arch(), osRelease: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), loadAverageAtStart: os.loadavg() }, chromium: browser.version(),
    measurement: 'Double-requestAnimationFrame minimal DOM feedback harness; not full React board paint. Cold startup is reported separately and excluded from warm submission latency. A fresh engine and evidence session per hypothetical unknown/detail answer, initialized before the warm clock; known/no-detail starts no engine. Explicit shared-stress retains engine TT and evidence and is order-dependent. No accuracy claim without the independent comparator.',
    modes: [] };
try {
    for (const mode of modes) {
        const context = await browser.newContext(mode === 'mobile-cpu4' ? devices['Pixel 7'] : { viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: mode === 'mobile-cpu4' ? 4 : 1 });
        const entry = { mode, cpuThrottleRateRequested: mode === 'mobile-cpu4' ? 4 : 1, throttleLimit: 'CDP renderer CPU emulation; worker throttling and physical mobile performance are not guaranteed.', positions: [], errors: [] };
        page.on('pageerror', error => entry.errors.push(String(error)));
        for (const manifest of corpus) {
            await page.goto(`http://127.0.0.1:${address.port}/`);
            await page.waitForFunction(() => typeof window.runPosition === 'function');
            try {
                const position = await page.evaluate(manifest => window.runPosition(manifest), manifest);
                entry.positions.push(position);
                console.log(JSON.stringify({ mode, revisionId: manifest.revisionId, moves: position.rows.length, unresolved: position.rows.filter(row => row.unresolved).length }));
            } catch (error) { entry.errors.push({ revisionId: manifest.revisionId, error: String(error) }); }
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, JSON.stringify({ ...report, modes: [...report.modes, entry] }, null, 2));
        }
        const rows = entry.positions.flatMap(position => position.rows);
        entry.summary = { requestedMoments: corpus.length, measuredMoments: entry.positions.length, failedMoments: corpus.length - entry.positions.length, moves: rows.length, supported: rows.filter(row => !row.unresolved).length,
            unresolved: rows.filter(row => row.unresolved).length, timeouts: rows.filter(row => row.timedOut).length,
            knownQualityInvalidated: rows.filter(row => row.knownQualityInvalidated).length,
            patchValidationFailures: rows.filter(row => row.patchValidation?.success === false).length,
            coldStartupMs: metric(rows.map(row => row.coldStartupMs)),
            startupFailures: rows.filter(row => row.startupError !== null).length,
            runtimePatchBytes: metric(rows.map(row => row.runtimePatchBytes)),
            lookupMs: metric(rows.map(row => row.lookupMs)), harnessPaintMs: metric(rows.map(row => row.initialHarnessPaintMs)),
            firstLiveMs: metric(rows.map(row => row.firstLiveMs)), supportedQualityMs: metric(rows.map(row => row.supportedQualityMs)),
            unknownSupportedQualityMs: metric(rows.filter(row => row.initialQuality === 'UNKNOWN').map(row => row.supportedQualityMs)),
            requestedNodes: metric(rows.map(row => row.planner.requestedNodes)), reportedNodes: metric(rows.map(row => row.planner.reportedNodes)),
            byStratum: Object.fromEntries([...new Set(rows.map(row => row.stratum))].map(stratum => { const subset = rows.filter(row => row.stratum === stratum); return [stratum, { count: subset.length, supported: subset.filter(row => !row.unresolved).length, supportedQualityMs: metric(subset.map(row => row.supportedQualityMs)) }]; })) };
        report.modes.push(entry); await context.close();
        await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
    }
    report.completedAt = new Date().toISOString(); report.loadAverageAtEnd = os.loadavg(); await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Report: ${output}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
