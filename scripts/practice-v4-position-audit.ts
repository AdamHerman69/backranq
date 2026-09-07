import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { Chess, type Square } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { assessPracticePosition, buildPracticeMomentRevision } from '@/lib/analysis/practiceMomentBuilder';
import { assessPracticeExactPosition } from '@/lib/analysis/practiceExactEvidence';
import { assessPracticeReferenceReadiness, detectPracticeReferenceDrift, toleranceCp, type PracticeReferenceReadiness } from '@/lib/training/assessmentPolicy';
import { gradeKnownLocalMove, gradeUnknownLocalMove, createLocalAnalysisSession, type LocalMoveEvaluation } from '@/lib/training/localGrading';
import { AnalysisWorkPlanner } from '@/lib/analysis/analysisWorkPlanner';
import { canonicalJson, canonicalPracticeSemantics, DEFAULT_ASSESSMENT_POLICY, practiceContextId, parsePracticeMomentRevision, validatePracticeEvaluationPatch, type PracticeMomentRevision, type SourceDecision } from '@/lib/training/practiceContract';
import type { NormalizedGame } from '@/lib/types/game';
import { loadAdditionalAuditSources } from './lib/practice-audit-sources';
import { openPaidComparatorCache, type PaidComparatorCache } from './lib/practice-audit-reuse-cache';
import { AuditWorkBudget, auditComparatorVerdict, comparatorNeedsReferenceRefresh } from './lib/practice-audit-comparator';

/**
 * Bounded offline quality audit, not a feed extractor or browser latency test.
 * node scripts/run-practice-v4-position-audit.mjs list <dir>
 * node scripts/run-practice-v4-position-audit.mjs capture <dir> --start=0 --limit=1
 * node scripts/run-practice-v4-position-audit.mjs compare <dir> --start=0 --limit=1
 * Resume only reuses completed fingerprint-matching positions. Partial progress
 * is diagnostic; a restarted position reruns its measured choices so latency
 * does not silently mix warm transposition tables with a fresh process.
 * --input-manifests=<file> imports the exact positive manifests exported by
 * practice-v4-audit.ts and adds ten curated RULE edge cases without reanalysis.
 * --input-sources=<file> appends strictly corpus-validated real positions.
 * --reuse-comparator=<v8-directory> regrades immutable stronger physical evidence
 * under current policy. Actual producer and every runtime answer remain fresh.
 * Unready reference takes the full fresh bounded comparator path.
 * Default independent answers match ordinary per-attempt evidence lifetime.
 * Use --session-mode=shared on both capture/compare only for retained-pool stress.
 */
const corpusPath = 'tests/fixtures/training-v2/real-games.corpus.v1.json';
const ARTIFACT_VERSION = 9;
type SessionMode = 'INDEPENDENT_ANSWERS' | 'SHARED_STRESS';
const localEngineProtocol = (mode: SessionMode) => mode === 'INDEPENDENT_ANSWERS' ? 'FRESH_ENGINE_AND_SESSION_PER_ANSWER' : 'SHARED_ENGINE_TT_AND_SESSION_ORDER_DEPENDENT';
const budgets = { capture: [200_000, 400_000, 800_000], comparatorReference: [1_600_000, 3_200_000, 6_400_000], comparatorProbe: [1_600_000, 3_200_000, 6_400_000], comparatorMove: [800_000, 1_600_000], captureMaximumNodes: 2_800_000, comparatorReferenceMaximumNodes: 22_400_000, captureSearchTimeoutMs: 30_000, comparatorSearchTimeoutMs: 120_000, localNodes: 1_500_000, localWallMs: 8_000 };
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
function write(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
function codeFingerprint() {
    const files: string[] = [];
    const visit = (directory: string) => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) visit(file); else if (/\.(ts|mjs|js)$/.test(item.name)) files.push(file); } };
    for (const directory of ['src/lib/analysis', 'src/lib/training', 'src/lib/chess', 'src/lib/crypto']) visit(directory);
    files.push('scripts/practice-v4-position-audit.ts', 'scripts/lib/practice-audit-comparator.ts', 'scripts/lib/practice-audit-sources.ts', 'scripts/lib/practice-audit-reuse.ts', 'scripts/lib/practice-audit-reuse-cache.ts', 'scripts/run-practice-v4-position-audit.mjs', 'public/vendor/stockfish/backranq-engine.worker.js', 'pnpm-lock.yaml');
    return hash(files.sort().map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}
type SourceKind = 'REAL_SOURCE_POSITION' | 'CURATED_RULE_EDGE' | 'EXTRACTOR_EMITTED';
type AuditDataset = { paidComparator?: PaidComparatorCache; additionalSourcesSha256: string | null; additionalSourcesBytes: string | null; sources: SourceDecision[]; imported: Map<string, PracticeMomentRevision>; inputSha256: string | null; inputBytes: string | null; extractorFingerprint: string | null };
type AuditWorkReport = ReturnType<AuditWorkBudget['report']> & { readiness: PracticeReferenceReadiness | null; termination: string };
type Capture = { referenceWork: AuditWorkReport | null; artifactVersion: number; fingerprint: string; index: number; sourceKind: SourceKind; sourceHash: string; method: 'ENGINE_CAPTURE' | 'RULE_CAPTURE' | 'IMPORTED_EXTRACTOR'; manifest: PracticeMomentRevision | null; captureMs: number; error: string | null; cost: ReturnType<typeof cost> };
type Run = { artifactVersion: number; fingerprint: string; codeSha256: string; corpusSha256: string; sourcesSha256: string; policy: typeof DEFAULT_ASSESSMENT_POLICY; budgets: typeof budgets; engineIdentity: unknown; sessionMode: SessionMode; createdAt: string };
const sourceKind = (source: SourceDecision, dataset: AuditDataset): SourceKind => dataset.imported.has(source.contextId) ? 'EXTRACTOR_EMITTED' : source.gameId.startsWith('exact-edge-') ? 'CURATED_RULE_EDGE' : 'REAL_SOURCE_POSITION';
function validateCapture(record: Capture, run: Run, source: SourceDecision, index: number, dataset: AuditDataset) {
    if (record.artifactVersion !== ARTIFACT_VERSION || record.fingerprint !== run.fingerprint || record.index !== index || record.sourceHash !== hash(source) || record.sourceKind !== sourceKind(source, dataset)) throw new Error(`Incompatible capture ${index}; use a new output directory`);
    const imported = dataset.imported.get(source.contextId);
    if (record.method !== (imported ? 'IMPORTED_EXTRACTOR' : record.sourceKind === 'CURATED_RULE_EDGE' ? 'RULE_CAPTURE' : 'ENGINE_CAPTURE')) throw new Error('Capture method differs from source');
    if (record.manifest) {
        if (imported && canonicalJson(imported) !== canonicalJson(record.manifest)) throw new Error('Imported manifest changed its original paid evidence');
        parsePracticeMomentRevision(record.manifest);
        if (canonicalJson(record.manifest.source) !== canonicalJson(source) || hash(canonicalPracticeSemantics(record.manifest)) !== record.manifest.semanticHash) throw new Error(`Invalid manifest source/hash ${index}`);
    }
}
function cost(pool: PositionAnalysisPool) { return pool.report(); }
const metadata = () => ({ date: new Date().toISOString(), cpu: cpus()[0]?.model, cores: cpus().length,
    platform: platform(), release: release(), node: process.version,
    corpusSha256: createHash('sha256').update(fs.readFileSync(corpusPath)).digest('hex') });
function samples(): SourceDecision[] {
    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as { games: NormalizedGame[] };
    const sources: SourceDecision[] = [];
    for (const game of corpus.games) {
        const board = new Chess(); board.loadPgn(game.pgn); const moves = board.history({ verbose: true });
        for (const ply of [8, 17, 24, 33, 40]) {
            const move = moves[ply]; if (!move || sources.length >= 50) continue;
            const trainingSide = move.color === 'w' ? 'WHITE' : 'BLACK'; const positionHistory = moves.slice(0, ply).map(m => m.before);
            const contextId = practiceContextId(move.before, positionHistory, trainingSide);
            if (sources.some(source => source.contextId === contextId)) continue;
            sources.push({ gameId: game.id, sourcePgnHash: hashSourcePgn(game.pgn), decisionPly: ply, fen: move.before,
                positionHistory, trainingSide, originalMoveUci: move.lan, contextId: practiceContextId(move.before, positionHistory, trainingSide) });
        }
    }
    // Ten distinct legal exact-edge positions, clearly separated from source-game samples.
    for (const king of ['g6', 'f6', 'f7', 'g5', 'f5'] as Square[]) for (const file of 'abcdefgh') for (let rank = 1; rank <= 8; rank++) {
        if (sources.length >= 60) break;
        const queen = `${file}${rank}` as Square; if (queen === king || queen === 'h8') continue;
        const board = new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1'); board.clear();
        board.put({ type: 'k', color: 'b' }, 'h8'); board.put({ type: 'k', color: 'w' }, king); board.put({ type: 'q', color: 'w' }, queen);
        if (board.isAttacked('h8', 'w') || board.isCheck()) continue;
        const moves = board.moves({ verbose: true });
        const stalemate = moves.find(move => new Chess(move.after).isStalemate());
        if (!stalemate || !moves.some(move => new Chess(move.after).isCheckmate())) continue;
        const fen = board.fen(); const pgn = `[SetUp "1"]\n[FEN "${fen}"]\n\n1. ${stalemate.san} *`;
        sources.push({ gameId: `exact-edge-${sources.length - 50}`, sourcePgnHash: hashSourcePgn(pgn), decisionPly: 0,
            fen, positionHistory: [], trainingSide: 'WHITE', originalMoveUci: stalemate.lan, contextId: practiceContextId(fen, [], 'WHITE') });
    }
    if (sources.length !== 60 || new Set(sources.map(s => s.contextId)).size !== 60) throw new Error(`Need sixty distinct contexts; total=${sources.length}, distinct=${new Set(sources.map(s => s.contextId)).size}, real=${sources.filter(s => !s.gameId.startsWith('exact-edge-')).length}`);
    return sources;
}
function loadDataset(file?: string, additionalFile?: string): AuditDataset {
    const append = (dataset: Omit<AuditDataset, 'additionalSourcesSha256' | 'additionalSourcesBytes'>): AuditDataset => {
        const bytes = additionalFile ? fs.readFileSync(additionalFile) : null;
        const sources = bytes ? loadAdditionalAuditSources(bytes.toString(), read<{ games: NormalizedGame[] }>(corpusPath), dataset.sources) : dataset.sources;
        return { ...dataset, sources, additionalSourcesSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
            additionalSourcesBytes: bytes?.toString() ?? null };
    };
    if (!file) return append({ sources: samples(), imported: new Map(), inputSha256: null, inputBytes: null, extractorFingerprint: null });
    const bytes = fs.readFileSync(file); const input = JSON.parse(bytes.toString()) as { version: number; extractorFingerprint: string; manifests: unknown[] };
    if (input.version !== 1 || !/^[0-9a-f]{64}$/.test(input.extractorFingerprint) || !Array.isArray(input.manifests) || !input.manifests.length
        || Object.keys(input).some(key => !['version', 'extractorFingerprint', 'manifests'].includes(key))) throw new Error('Invalid extractor manifest input');
    const imported = new Map<string, PracticeMomentRevision>();
    for (const value of input.manifests) {
        const manifest = parsePracticeMomentRevision(value);
        if (hash(canonicalPracticeSemantics(manifest)) !== manifest.semanticHash || manifest.decision.status !== 'CONFIRMED_MISTAKE' || manifest.decision.selection !== 'INCLUDED') throw new Error('Input must contain hash-valid trainable extractor manifests');
        if (imported.has(manifest.source.contextId)) throw new Error('Duplicate imported context');
        imported.set(manifest.source.contextId, manifest);
    }
    const sources = [...imported.values()].map(manifest => manifest.source);
    for (const source of samples().slice(50)) if (!imported.has(source.contextId)) sources.push(source);
    return append({ sources, imported, inputSha256: createHash('sha256').update(bytes).digest('hex'), inputBytes: bytes.toString(), extractorFingerprint: input.extractorFingerprint });
}
async function openRun(directory: string, engine: ServerStockfishClient, sessionMode: SessionMode, dataset: AuditDataset): Promise<Run> {
    const engineIdentity = await engine.getIdentity();
    const identity = { artifactVersion: ARTIFACT_VERSION, codeSha256: codeFingerprint(), corpusSha256: metadata().corpusSha256,
        sourcesSha256: hash(dataset.sources), inputSha256: dataset.inputSha256, additionalSourcesSha256: dataset.additionalSourcesSha256, extractorFingerprint: dataset.extractorFingerprint, paidComparatorFingerprint: dataset.paidComparator?.fingerprint ?? null, policy: DEFAULT_ASSESSMENT_POLICY, budgets, engineIdentity, sessionMode, localEngineProtocol: localEngineProtocol(sessionMode) };
    const fingerprint = hash(identity); const file = path.join(directory, 'run.json');
    if (fs.existsSync(file)) { const prior = read<Run>(file); if (prior.fingerprint !== fingerprint) throw new Error('Resume fingerprint differs in source/code/engine/policy/budget; use a new output directory'); return prior; }
    const run = { ...identity, fingerprint, createdAt: new Date().toISOString() }; write(file, run); return run;
}
function captureSummary(directory: string, run: Run, source: SourceDecision[], records: Capture[]) {
    const summary = { ...metadata(), fingerprint: run.fingerprint, sessionMode: run.sessionMode, plannedPositions: source.length, capturedPositions: records.length,
        validPositions: records.filter(r => r.manifest).length, failedPositions: records.filter(r => !r.manifest).length,
        sourceKinds: Object.fromEntries(['REAL_SOURCE_POSITION', 'CURATED_RULE_EDGE', 'EXTRACTOR_EMITTED'].map(kind => [kind, records.filter(r => r.sourceKind === kind).length])),
        includedPositionCandidates: records.filter(r => r.manifest?.decision.selection === 'INCLUDED').length,
        extractedFeedMoments: records.filter(r => r.sourceKind === 'EXTRACTOR_EMITTED' && r.manifest).length, sixtyPositionStratifiedGate: 'NOT_MEASURED',
        missing: ['Sixty comparator-completed positions with at least ten empirically classified cases per required stratum', 'Browser/mobile paint and cold startup timings', 'Human adjudication of supported comparator disagreements'],
        manifestPaths: records.filter(r => r.manifest).map(r => `position-${r.index}.json`),
        note: 'Only imported extractor outputs count as emitted feed moments. Import costs measure validation, not original extraction; original paid evidence remains unchanged in each manifest. Direct source and curated RULE positions are counted separately.' };
    write(path.join(directory, 'capture-summary.json'), summary); return summary;
}
async function capture(directory: string, start: number, limit: number, sessionMode: SessionMode, dataset: AuditDataset) {
    const source = dataset.sources; const engine = new ServerStockfishClient();
    try {
        const run = await openRun(directory, engine, sessionMode, dataset);
        // Validate each immutable resumed record once. Summary updates only use
        // this invocation's validated records, never reparse the growing corpus.
        const records = new Map<number, Capture>();
        for (const [index, item] of source.entries()) {
            const file = path.join(directory, `position-${index}.json`);
            if (!fs.existsSync(file)) continue;
            const record = read<Capture>(file); validateCapture(record, run, item, index, dataset); records.set(index, record);
        }
        const summarize = () => captureSummary(directory, run, source, [...records.values()].sort((a, b) => a.index - b.index));
        for (let i = start; i < Math.min(source.length, start + limit); i++) {
            const target = path.join(directory, `position-${i}.json`); const current = source[i];
            if (records.has(i)) continue;
            const pool = new PositionAnalysisPool(); const wrapped = pool.wrap(engine); const started = performance.now();
            let manifest: PracticeMomentRevision | null = null; let error: string | null = null; let referenceWork: AuditWorkReport | null = null;
            try {
                const imported = dataset.imported.get(current.contextId);
                if (imported) manifest = imported;
                else {
                const exact = assessPracticeExactPosition({ ...current });
                const exactRoot = exact && exact.decision.status !== 'UNRESOLVED' ? exact : null;
                if (!exactRoot) {
                    const work = new AuditWorkBudget({ root: budgets.capture,
                        probe: budgets.capture.filter(nodes => nodes >= DEFAULT_ASSESSMENT_POLICY.minimumReferenceProbeNodes),
                        move: budgets.capture, maximumRequestedNodes: budgets.captureMaximumNodes });
                    let termination = 'UNRESOLVED';
                    while (true) {
                        const assessed = assessPracticePosition({ ...current, pool, minimumConfirmationNodes: budgets.capture[0] });
                        const readiness = assessed ? assessPracticeReferenceReadiness({ evidence: assessed.evidence, frame: assessed.frame,
                            trainingSide: current.trainingSide, referenceMoveUci: assessed.rootAnswerIndex.preferredMoveUci }) : null;
                        if (assessed && assessed.decision.status !== 'UNRESOLVED') { termination = 'DECISION_RESOLVED'; referenceWork = { ...work.report(), readiness, termination }; break; }
                        const job = readiness?.requiredWork === null ? work.take('MOVE', current.originalMoveUci) : work.takeReference(readiness);
                        if (!job) { termination = work.report().stopReason ?? 'NO_REQUIRED_WORK'; referenceWork = { ...work.report(), readiness, termination }; break; }
                        const request = { fen: current.fen, previousFens: current.positionHistory, nodes: job.nodes,
                            timeoutMs: budgets.captureSearchTimeoutMs, reuse: 'FRESH_REQUIRED' as const };
                        referenceWork = { ...work.report(), readiness, termination: 'SEARCH_IN_FLIGHT' };
                        if (job.kind === 'ROOT') await wrapped.analyzeMultiPv({ ...request, multiPv: 5, purpose: 'MISSING_REFERENCE' });
                        else await wrapped.evalPosition({ ...request, rootMoves: [job.moveUci!], purpose: job.kind === 'REFERENCE_PROBE' ? 'VERIFY_REFERENCE' : 'MISSING_MOVE' });
                    }
                }
                manifest = await buildPracticeMomentRevision({ pool, source: current, minimumConfirmationNodes: budgets.capture[0], executionProfileId: 'audit-standard-200k', exactRoot });
                }
                if (!manifest) throw new Error('Missing root');
                parsePracticeMomentRevision(manifest);
            } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); manifest = null; if (referenceWork) referenceWork.termination = 'CAPTURE_FAILED'; }
            const record: Capture = { artifactVersion: ARTIFACT_VERSION, fingerprint: run.fingerprint, index: i, sourceKind: sourceKind(current, dataset), method: dataset.imported.has(current.contextId) ? 'IMPORTED_EXTRACTOR' : sourceKind(current, dataset) === 'CURATED_RULE_EDGE' ? 'RULE_CAPTURE' : 'ENGINE_CAPTURE', sourceHash: hash(current), manifest, captureMs: performance.now() - started, error, referenceWork, cost: cost(pool) };
            write(target, record); records.set(i, record); summarize();
            console.log(JSON.stringify({ capturedIndex: i, sourceKind: record.sourceKind, decision: manifest?.decision.status ?? null, error }));
        }
        summarize();
    } finally { engine.terminate(); }
}
type MoveRow = { moveUci: string; immediate: boolean; quality: string; qualityMs: number; resolveMs: number; coldStartupMs: number | null; validationMs: number; firstLiveMs: number | null; patchValid: boolean | null; patchIssues: string[]; runtimeAssessment: LocalMoveEvaluation['assessment']; runtimePatch: LocalMoveEvaluation['patch']; runtimePatchBytes: number; cost: ReturnType<AnalysisWorkPlanner['report']> } & Partial<ReturnType<typeof auditComparatorVerdict>>;
const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
async function compare(directory: string, start: number, limit: number, sessionMode: SessionMode, dataset: AuditDataset) {
    const sources = dataset.sources; const comparator = new ServerStockfishClient();
    let sharedLocal: ServerStockfishClient | null = null;
    try {
        const run = await openRun(directory, comparator, sessionMode, dataset);
        for (let index = start; index < Math.min(sources.length, start + limit); index++) {
            const inputFile = path.join(directory, `position-${index}.json`); if (!fs.existsSync(inputFile)) continue;
            const captured = read<Capture>(inputFile); validateCapture(captured, run, sources[index], index, dataset); if (!captured.manifest) continue;
            const target = path.join(directory, `comparison-${index}.json`); const captureHash = hash(captured);
            if (fs.existsSync(target)) { const prior = read<{fingerprint: string; captureHash: string}>(target); if (prior.fingerprint !== run.fingerprint || prior.captureHash !== captureHash) throw new Error('Comparator resume fingerprint mismatch'); continue; }
            const manifest = captured.manifest; const source = manifest.source; const pool = new PositionAnalysisPool(); const strong = pool.wrap(comparator);
            const sharedSession = createLocalAnalysisSession();
            const rootNode = manifest.continuation.nodes.find(node => node.contextId === source.contextId && node.role === 'USER');
            const node = { ...(rootNode ?? { id: source.contextId, contextId: source.contextId, fen: source.fen, positionHistory: source.positionHistory, trainingSide: source.trainingSide, role: 'USER' as const, answerIndex: manifest.rootAnswerIndex }), ply: 0 };
            const moves = manifest.rootAnswerIndex.legalMovesUci;
            const rows: MoveRow[] = [];
            const work = new AuditWorkBudget({ root: budgets.comparatorReference, probe: budgets.comparatorProbe,
                move: budgets.comparatorMove, maximumRequestedNodes: budgets.comparatorReferenceMaximumNodes + moves.length * budgets.comparatorMove.reduce((sum, nodes) => sum + nodes, 0) });
            const paid = dataset.paidComparator?.project(source, await comparator.getIdentity()) ?? null;
            const reused = paid?.reusableGround ? paid : null;
            if (!reused) {
            const initialRoot = work.take('ROOT')!;
            await strong.analyzeMultiPv({ fen: source.fen, previousFens: source.positionHistory, nodes: initialRoot.nodes, multiPv: 5,
                timeoutMs: budgets.comparatorSearchTimeoutMs, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
            }
            for (const moveUci of moves) {
                const lookupStarted = performance.now();
                const known = gradeKnownLocalMove({ manifest, node, moveUci, session: sessionMode === 'SHARED_STRESS' ? sharedSession : undefined });
                const lookupMs = performance.now() - lookupStarted;
                let answerEngine: ServerStockfishClient | null = null; let coldStartupMs: number | null = null;
                let result: LocalMoveEvaluation; let resolveMs: number;
                let firstLiveMs: number | null = null; let firstSupportedMs: number | null = null;
                let planner: AnalysisWorkPlanner;
                try {
                    if (!known) {
                        const startupStarted = performance.now();
                        const newlyCreated = sessionMode !== 'SHARED_STRESS' || !sharedLocal;
                        answerEngine = sessionMode === 'SHARED_STRESS' ? sharedLocal ??= new ServerStockfishClient() : new ServerStockfishClient();
                        if (canonicalJson(await answerEngine.getIdentity()) !== canonicalJson(run.engineIdentity)) throw new Error('Local engine identity differs');
                        if (newlyCreated) coldStartupMs = performance.now() - startupStarted;
                    }
                    // Fresh TT and identity ready; initialization is outside the warm grading budget/clock.
                    planner = new AnalysisWorkPlanner({ maxNodes: budgets.localNodes, maxWallMs: budgets.localWallMs });
                    const started = performance.now();
                    result = known ?? await gradeUnknownLocalMove({ manifest, node, moveUci, engine: answerEngine!, session: sessionMode === 'SHARED_STRESS' ? sharedSession : createLocalAnalysisSession(), planner,
                        onUpdate: update => { if (update.kind === 'LIVE' && firstLiveMs === null) firstLiveMs = performance.now() - started; if (update.kind === 'SUPPORTED' && firstSupportedMs === null) firstSupportedMs = performance.now() - started; } });
                    resolveMs = known ? lookupMs : performance.now() - started;
                } finally { if (sessionMode !== 'SHARED_STRESS') answerEngine?.terminate(); }
                const runtimeCost = planner.report(); const validationStarted = performance.now();
                const checked = result.patch ? validatePracticeEvaluationPatch(manifest, result.patch) : null;
                const validationMs = performance.now() - validationStarted;
                // Preserve the exact conclusion/evidence at this answer, even in retained-session stress runs.
                const runtimePatch = structuredClone(result.patch); const runtimeAssessment = structuredClone(result.assessment);
                rows.push({ moveUci, immediate: Boolean(known), quality: result.result.status === 'GRADED' ? result.result.quality : 'UNKNOWN', qualityMs: firstSupportedMs ?? resolveMs, resolveMs, coldStartupMs, validationMs,
                    firstLiveMs, patchValid: checked?.success ?? null, patchIssues: checked && !checked.success ? checked.issues : [], runtimeAssessment, runtimePatch,
                    runtimePatchBytes: runtimePatch ? Buffer.byteLength(JSON.stringify(runtimePatch)) : 0, cost: runtimeCost });
                const progress = { artifactVersion: ARTIFACT_VERSION, fingerprint: run.fingerprint, sessionMode, captureHash, index, contextId: source.contextId, complete: false, legalMoves: moves.length, rows };
                write(path.join(directory, `comparison-${index}-progress.json`), { ...progress, phase: 'COMPARATOR_MOVE', completedMoveCount: rows.length - 1, updatedAt: new Date().toISOString() });
                // The comparator must collect its own two completed physical
                // searches. Applying corroboration to one old search would
                // merely hide disagreements behind an unresolved comparator.
                for (let pass = 0; !reused && pass < budgets.comparatorMove.length; pass++) {
                    const job = work.take('MOVE', moveUci);
                    if (!job) throw new Error('Comparator answer reservation unexpectedly exceeded its declared total');
                    await strong.evalPosition({ fen: source.fen, previousFens: source.positionHistory, rootMoves: [moveUci], nodes: job.nodes,
                        timeoutMs: budgets.comparatorSearchTimeoutMs, purpose: 'MISSING_MOVE', reuse: 'FRESH_REQUIRED' });
                }
                write(path.join(directory, `comparison-${index}-progress.json`), { ...progress, phase: 'NEXT_MOVE', completedMoveCount: rows.length, comparatorCost: cost(pool), updatedAt: new Date().toISOString() });
                console.log(JSON.stringify({ index, completedMoves: rows.length, legalMoves: moves.length, moveUci, quality: rows.at(-1)!.quality, qualityMs: rows.at(-1)!.qualityMs, validationMs: rows.at(-1)!.validationMs, patchValid: rows.at(-1)!.patchValid }));
            }
            let comparison = reused ? { ...reused.manifest, frame: reused.manifest.frames[0] } : assessPracticePosition({ ...source, pool, minimumConfirmationNodes: budgets.comparatorMove[0], policy: manifest.policySnapshot });
            const drift = () => comparison && detectPracticeReferenceDrift({ evidence: comparison.evidence, frame: comparison.frame, trainingSide: source.trainingSide, referenceMoveUci: comparison.rootAnswerIndex.preferredMoveUci, policy: manifest.policySnapshot });
            const currentReference = () => { const current = comparison; return current?.assessments.find(a => a.id === current.frame.referenceAssessmentId); };
            const readinessForCurrent = () => comparison ? assessPracticeReferenceReadiness({ evidence: comparison.evidence, frame: comparison.frame,
                trainingSide: source.trainingSide, referenceMoveUci: comparison.rootAnswerIndex.preferredMoveUci, policy: manifest.policySnapshot }) : null;
            let readiness = readinessForCurrent();
            // All-legal singleton searches are already in the same pool. READY
            // reuses them; only the shared current dependency authorizes more work.
            while (!reused && readiness?.requiredWork !== null) {
                const job = work.takeReference(readiness); if (!job) break;
                const request = { fen: source.fen, previousFens: source.positionHistory, nodes: job.nodes,
                    timeoutMs: budgets.comparatorSearchTimeoutMs, reuse: 'FRESH_REQUIRED' as const };
                if (job.kind === 'ROOT') await strong.analyzeMultiPv({ ...request, multiPv: 5, purpose: 'REFERENCE_DRIFT' });
                else await strong.evalPosition({ ...request, rootMoves: [job.moveUci!], purpose: 'VERIFY_REFERENCE' });
                comparison = assessPracticePosition({ ...source, pool, minimumConfirmationNodes: budgets.comparatorMove[0], policy: manifest.policySnapshot });
                readiness = readinessForCurrent();
            }
            if (!comparison) throw new Error('Comparator lost full-scope reference');
            const remainingDrift = drift();
            const reference = currentReference();
            const referenceResolved = readiness?.status === 'READY' && !comparatorNeedsReferenceRefresh(reference, Boolean(remainingDrift));
            const exact = assessPracticeExactPosition({ ...source, policy: manifest.policySnapshot });
            for (const row of rows) {
                const rule = exact?.assessments.find(a => a.moveUci === row.moveUci && a.qualitySupport === 'SUPPORTED');
                const assessment = comparison.assessments.find(a => a.moveUci === row.moveUci);
                Object.assign(row, auditComparatorVerdict({ runtimeQuality: row.quality, assessment, reference: referenceResolved ? reference : undefined, hasDrift: Boolean(remainingDrift), rule }));
            }
            const good = rows.filter(r => r.comparatorQuality === 'GOOD').length; const unresolved = rows.filter(r => r.comparatorQuality === 'UNKNOWN').length;
            const provedPreferredMove = exact?.rootAnswerIndex.preferredMoveUci ?? (referenceResolved ? comparison.rootAnswerIndex.preferredMoveUci : null);
            const bestMove = new Chess(source.fen).moves({ verbose: true }).find(move => move.lan === provedPreferredMove);
            const boundary = referenceResolved && comparison.assessments.some(a => a.qualitySupport === 'SUPPORTED' && (a.metrics.lossCp !== null && reference?.score?.kind === 'CP' && Math.abs(a.metrics.lossCp - toleranceCp(reference.score.cp, manifest.policySnapshot)) <= 40 || a.metrics.lossExpectedScore !== null && Math.abs(a.metrics.lossExpectedScore - manifest.policySnapshot.maxExpectedScoreLoss) <= .04));
            const report = { artifactVersion: ARTIFACT_VERSION, fingerprint: run.fingerprint, sessionMode, localEngineProtocol: localEngineProtocol(sessionMode), captureHash, index, sourceKind: captured.sourceKind, contextId: source.contextId, fen: source.fen, sourceGameId: source.gameId,
                decisionStatus: manifest.decision.status, feedSelection: manifest.decision.selection, extractedFeedMoment: captured.sourceKind === 'EXTRACTOR_EMITTED', legalMoves: moves.length, rows,
                categories: { narrow: moves.length > 1 && unresolved === 0 && good > 0 && good <= 3, forcedMoveControl: moves.length === 1, broad: good >= 5, goodCount: good, unknownCount: unresolved,
                    boundary, tactical: Boolean(bestMove && (bestMove.captured || bestMove.promotion || /[+#]/.test(bestMove.san))) || referenceResolved && reference?.score?.kind === 'MATE',
                    saturated: referenceResolved && reference?.score?.kind === 'CP' && Math.abs(reference.score.cp) >= 300, exactRule: Boolean(exact), tablebase: false },
                comparator: { budgets, work: { ...work.report(), readiness, termination: reused ? 'PAID_EVIDENCE_REPROJECTED' : readiness?.status === 'READY' ? 'REFERENCE_READY' : work.report().stopReason ?? 'UNRESOLVED_REFERENCE' }, reuse: paid ? { status: reused ? 'REPROJECTED_READY' : 'UNREADY_FRESH_FALLBACK', provenance: paid.provenance, retainedEvidenceCost: paid.retainedEvidenceCost, base: paid.base } : null, remainingDrift, referenceResolved, referenceAssessmentId: reference?.id ?? null, cost: cost(pool), evidence: comparison.evidence, assessments: comparison.assessments, frame: comparison.frame, exactEvidence: exact?.evidence ?? null } };
            write(target, report); write(path.join(directory, `comparison-${index}-progress.json`), { artifactVersion: ARTIFACT_VERSION, fingerprint: run.fingerprint, sessionMode, captureHash, index, complete: true, completedMoveCount: rows.length, reportFile: path.basename(target) }); console.log(JSON.stringify({ comparedIndex: index, legal: moves.length, unknownComparator: unresolved, disagreements: rows.filter(r => r.disagreement).length, invalidPatches: rows.filter(r => r.patchValid === false).length }));
        }
        const reports = sources.flatMap((source, index) => { const file = path.join(directory, `comparison-${index}.json`); if (!fs.existsSync(file)) return []; const record = read<{fingerprint: string; index: number; rows: MoveRow[]; sourceKind: SourceKind; categories: Record<string, boolean | number>; comparator: { cost: ReturnType<typeof cost>; reuse: { status: string; retainedEvidenceCost: { physicalSearches: number; requestedNodes: number } } | null } }>(file); if (record.fingerprint !== run.fingerprint) throw new Error('Mixed comparison fingerprint'); return [record]; });
        const rows = reports.flatMap(r => r.rows); const unknownAtSubmit = rows.filter(r => !r.immediate); const comparable = rows.filter(r => r.quality !== 'UNKNOWN' && r.comparatorQuality !== 'UNKNOWN');
        const metrics = (values: number[]) => ({ n: values.length, p50: percentile(values, .5), p95: percentile(values, .95) });
        const categoryCounts = Object.fromEntries(['narrow', 'broad', 'boundary', 'tactical', 'saturated', 'exactRule'].map(category => [category, reports.filter(r => r.categories[category] === true).length]));
        write(path.join(directory, 'comparison-summary.json'), { ...metadata(), artifactVersion: ARTIFACT_VERSION, fingerprint: run.fingerprint, sessionMode, localEngineProtocol: localEngineProtocol(sessionMode), plannedPositions: sources.length, positions: reports.length, positionsWithoutCompletedComparison: sources.length - reports.length, legalMoves: rows.length, extractedFeedMoments: reports.filter(r => r.sourceKind === 'EXTRACTOR_EMITTED').length,
            comparatorWork: { reprojectedPositions: reports.filter(r => r.comparator.reuse?.status === 'REPROJECTED_READY').length, unreadyFreshFallbackPositions: reports.filter(r => r.comparator.reuse?.status === 'UNREADY_FRESH_FALLBACK').length, freshPhysicalSearches: reports.reduce((n, r) => n + r.comparator.cost.physicalSearches, 0), freshRequestedNodes: reports.reduce((n, r) => n + r.comparator.cost.requestedNodes, 0), reusedEvidenceRequestedNodes: reports.reduce((n, r) => n + (r.comparator.reuse?.status === 'REPROJECTED_READY' ? r.comparator.reuse.retainedEvidenceCost.requestedNodes : 0), 0) },
            immediate: { count: rows.filter(r => r.immediate).length, denominator: rows.length }, runtimeUnresolved: rows.filter(r => r.quality === 'UNKNOWN').length,
            comparatorUnresolved: rows.filter(r => r.comparatorQuality === 'UNKNOWN').length, comparable: comparable.length,
            comparatorUnresolvedReasons: Object.fromEntries(['REFERENCE_UNRESOLVED', 'REFERENCE_DRIFT', 'MOVE_UNRESOLVED'].map(reason => [reason, rows.filter(r => r.comparatorUnresolvedReason === reason).length])),
            diagnosticCandidateDisagreements: rows.filter(r => r.candidateDisagreement).length,
            diagnosticDisagreementsExcludedFromGround: rows.filter(r => r.candidateDisagreement && r.comparatorQuality === 'UNKNOWN').length,
            falseGood: comparable.filter(r => r.quality === 'GOOD' && r.comparatorQuality === 'BELOW_STANDARD').length,
            falseBelowStandard: comparable.filter(r => r.quality === 'BELOW_STANDARD' && r.comparatorQuality === 'GOOD').length,
            invalidPatches: rows.filter(r => r.patchValid === false).length, knownSearchViolations: rows.filter(r => r.immediate && r.cost.physicalSearches > 0).length,
            requestedNodeBudgetViolations: rows.filter(r => r.cost.requestedNodes > budgets.localNodes).length,
            knownLookupMs: metrics(rows.filter(r => r.immediate).map(r => r.qualityMs)), warmUnknownSupportedMs: metrics(unknownAtSubmit.filter(r => r.quality !== 'UNKNOWN').map(r => r.qualityMs)),
            patchValidationMs: metrics(rows.filter(r => r.patchValid !== null).map(r => r.validationMs)),
            runtimePatchBytes: { ...metrics(rows.map(r => r.runtimePatchBytes)), total: rows.reduce((sum, row) => sum + row.runtimePatchBytes, 0) },
            unknownResolveMs: metrics(unknownAtSubmit.map(r => r.resolveMs)),
            coldStartupMs: metrics(rows.flatMap(r => r.coldStartupMs === null ? [] : [r.coldStartupMs])),
            unknownFirstLiveMs: metrics(unknownAtSubmit.flatMap(r => r.firstLiveMs === null ? [] : [r.firstLiveMs])),
            forcedMoveControls: reports.filter(r => r.categories.forcedMoveControl === true).length,
            categoryCounts, categoryOverlap: reports.map(report => ({ index: report.index, categories: Object.keys(categoryCounts).filter(category => report.categories[category] === true) })),
            categoryDefinitions: { narrow: 'At least two legal moves, all classified, 1–3 GOOD', broad: 'At least five supported GOOD', boundary: 'At least one score within support margin of CP/E quality threshold', tactical: 'Preferred move is capture/promotion/check or reference has mate score', saturated: 'Absolute reference CP >=300', exactRule: 'Independently replayed RULE terminal outcome evidence' },
            releaseGates: { sixtyExtractorMomentsWithTenPerStratum: reports.filter(r => r.sourceKind === 'EXTRACTOR_EMITTED').length >= 60 && Object.values(categoryCounts).every(n => n >= 10) ? 'PASS' : 'INCOMPLETE', browserPaintAndMobile: 'NOT_MEASURED', tablebaseCases: 'NOT_MEASURED', humanAdjudication: 'REQUIRED_FOR_DISAGREEMENTS' },
            note: 'Every legal move is probed. Finite engine ground requires shared reference readiness plus a GOOD/SUPPORTED self-reference without drift. Reference root and probe ladders are independent and explicitly capped; all-legal singleton proof is reused when compatible. UNKNOWN excludes that row from the disagreement denominator; raw assessments and candidate disagreements remain diagnostic and still require adjudication. A smaller denominator does not establish a correctness fix. RULE outcomes independently override finite engine labels. Warm engine timings exclude browser paint and separately reported startup. INDEPENDENT_ANSWERS starts a fresh initialized engine (empty TT) and evidence session per hypothetical choice; known choices start no local engine. SHARED_STRESS retains both TT and earlier answers and is order-dependent. The fresh stronger comparator intentionally retains its own engine. Optional immutable v8 stronger evidence is regraded under current policy; reused pool cost is separate from new work and is not a fresh engine replication. Unready reused references trigger fresh bounded searches. Runtime answers are never reused.' });
    } finally { sharedLocal?.terminate(); comparator.terminate(); }
}
export async function main(argv: string[]) {
    const mode = argv[0] ?? 'list'; const directory = path.resolve(argv[1] ?? 'artifacts/practice-v4-positions');
    const option = (name: string, fallback: number) => { const raw = argv.find(arg => arg.startsWith(`--${name}=`)); const value = raw ? Number(raw.split('=')[1]) : fallback; if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`); return value; };
    const modeOption = argv.find(arg => arg.startsWith('--session-mode='))?.split('=')[1] ?? 'independent';
    if (!['independent', 'shared'].includes(modeOption)) throw new Error('Expected --session-mode=independent or shared');
    const sessionMode: SessionMode = modeOption === 'shared' ? 'SHARED_STRESS' : 'INDEPENDENT_ANSWERS';
    const dataset = loadDataset(argv.find(arg => arg.startsWith('--input-manifests='))?.slice('--input-manifests='.length), argv.find(arg => arg.startsWith('--input-sources='))?.slice('--input-sources='.length));
    const paidDirectory = argv.find(arg => arg.startsWith('--reuse-comparator='))?.slice('--reuse-comparator='.length);
    if (paidDirectory) dataset.paidComparator = openPaidComparatorCache(path.resolve(paidDirectory));
    const start = option('start', 0); const limit = option('limit', dataset.sources.length); fs.mkdirSync(directory, { recursive: true });
    for (const [filename, bytes] of [['input-manifests.json', dataset.inputBytes], ['input-sources.json', dataset.additionalSourcesBytes]] as const) {
        if (bytes === null) continue;
        const snapshot = path.join(directory, filename);
        if (fs.existsSync(snapshot) && fs.readFileSync(snapshot, 'utf8') !== bytes) throw new Error('Audit input snapshot changed; use a new directory');
        if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, bytes);
    }
    if (mode === 'list') write(path.join(directory, 'sources.json'), { ...metadata(), codeSha256: codeFingerprint(), sourceCount: dataset.sources.length, sessionMode, extractedFeedMoments: dataset.imported.size, inputSha256: dataset.inputSha256, additionalSourcesSha256: dataset.additionalSourcesSha256, extractorFingerprint: dataset.extractorFingerprint, budgets, sources: dataset.sources.map(source => ({ sourceKind: sourceKind(source, dataset), source })) });
    else if (mode === 'capture') await capture(directory, start, limit, sessionMode, dataset);
    else if (mode === 'compare') await compare(directory, start, limit, sessionMode, dataset);
    else throw new Error('Expected list, capture or compare; options: --start=N --limit=N --session-mode=independent|shared');
}
