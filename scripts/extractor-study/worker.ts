import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Chess } from 'chess.js';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { buildPracticeMomentRevision } from '@/lib/analysis/practiceMomentBuilder';
import { DEFAULT_ASSESSMENT_POLICY, practiceContextId } from '@/lib/training/practiceContract';
import { gradeKnownLocalMove, gradeUnknownLocalMove } from '@/lib/training/localGrading';
import { AnalysisWorkPlanner } from '@/lib/analysis/analysisWorkPlanner';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { MAX_ASSESSMENT_POSITION_HISTORY } from '@/lib/training/assessmentIdentity';
import { runStrategy } from './strategies';
import { auditReferencePositions, runReference } from './reference';
import { atomicJson, jsonFiles, readJson } from './io';
import { createMeteredEngine, emptyMeter } from './meter';
import { makeJob } from './jobs';
import { studyRuntime } from './runtime';
import type { AnswerResult, Attempt, JobResult, WorkerInput } from './records';

export async function runWorker(input: WorkerInput): Promise<void> {
    const { job, config, directory } = input;
    const attempt: Attempt = {
        fingerprint: input.fingerprint, job, attempt: input.attempt, state: 'RUNNING',
        startedAt: new Date().toISOString(), meter: emptyMeter(),
        nodeAllowance: input.nodeAllowance, cpuAllowance: input.cpuAllowance,
        workerPid: process.pid, host: os.hostname(),
    };
    atomicJson(input.journalPath, attempt);
    const runtime = studyRuntime();
    const raw = new ServerStockfishClient({ hashMb: 64, defaultTimeoutMs: 30000, runtimeFactory: runtime.factory });
    const meter = createMeteredEngine(raw, input.journalPath, attempt, runtime);
    const pool = new PositionAnalysisPool({ maxContexts: 512, maxSearches: 16384, maxCostSearches: 32768 });
    const engine = pool.wrap(meter.engine);
    const controller = new AbortController();
    const cancel = () => { controller.abort(); raw.cancelAll(); };
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    const orphaned = () => { cancel(); raw.terminate(); setTimeout(() => process.exit(2), 2000).unref(); };
    process.once('disconnect', orphaned);
    const result: JobResult = { fingerprint: input.fingerprint, job, state: 'RUNNING', meter: emptyMeter() };
    try {
        const item = input.corpus.games[job.gameIndex];
        if (!item) throw new Error('Missing corpus game');
        if (job.kind === 'PRODUCT') {
            if (!input.profile) throw new Error('Missing product profile');
            result.strategy = await runStrategy({ game: item, profile: input.profile, engine, signal: controller.signal });
            if (result.strategy.errors.length) throw new Error(result.strategy.errors.join('; '));
        } else if (job.kind === 'REFERENCE') {
            if (job.auditPlies) {
                result.reference = { samples: await auditReferencePositions({ game: item, config, engine, plies: job.auditPlies, signal: controller.signal }), scanCandidates: [], errors: [] };
            } else {
                const products = jsonFiles(path.join(directory, 'results')).map(p => readJson<JobResult>(p))
                    .filter(r => r.fingerprint === input.fingerprint && r.job.gameIndex === job.gameIndex && r.job.kind === 'PRODUCT' && r.state === 'COMPLETED');
                result.reference = await runReference({ game: item, config, engine,
                    admittedPlies: [...new Set(products.flatMap(r => r.strategy?.decisions.filter(d => d.admitted).map(d => d.ply) ?? []))],
                    candidatePlies: [...new Set(products.flatMap(r => r.strategy?.decisions.filter(d => d.candidate).map(d => d.ply) ?? []))],
                    signal: controller.signal });
            }
            if (result.reference.errors.length) throw new Error(result.reference.errors.join('; '));
        } else {
            if (job.ply == null || !job.moveUci) throw new Error('Missing answer identity');
            const product = readJson<JobResult>(path.join(directory, 'results', makeJob('PRODUCT', job.gameIndex, job.profileId).id + '.json'));
            if (product.fingerprint !== input.fingerprint || product.state !== 'COMPLETED' || !product.poolFile) throw new Error('Missing matching product evidence');
            const state = readJson<ReturnType<PositionAnalysisPool['serialize']>>(path.join(directory, product.poolFile));
            const originalPool = PositionAnalysisPool.hydrate(state, { maxContexts: 512, maxSearches: 16384, maxCostSearches: 32768 });
            const chess = new Chess(); chess.loadPgn(item.game.pgn);
            const history = chess.history({ verbose: true }); const move = history[job.ply];
            if (!move) throw new Error('Invalid answer source ply');
            const previous = history.slice(Math.max(0, job.ply - MAX_ASSESSMENT_POSITION_HISTORY), job.ply).map(m => m.before);
            const trainingSide = move.color === 'w' ? 'WHITE' : 'BLACK';
            const manifest = await buildPracticeMomentRevision({ pool: originalPool,
                source: { gameId: item.game.id, sourcePgnHash: hashSourcePgn(item.game.pgn), decisionPly: job.ply,
                    contextId: practiceContextId(move.before, previous, trainingSide), fen: move.before,
                    positionHistory: previous, trainingSide, originalMoveUci: move.lan },
                executionProfileId: 'study-common-strict-grading', minimumConfirmationNodes: 200000,
                policy: DEFAULT_ASSESSMENT_POLICY });
            const reference = readJson<JobResult>(path.join(directory, 'results', makeJob('REFERENCE', job.gameIndex, 'REFERENCE').id + '.json'));
            const sample = reference.reference?.samples.find(s => s.ply === job.ply);
            const referenceEstimate = job.moveUci === sample?.decision.originalMoveUci ? sample.decision.estimate
                : sample?.alternatives.find(a => a.moveUci === job.moveUci)?.estimate ?? 'UNKNOWN';
            const answer: AnswerResult = { ply: job.ply, moveUci: job.moveUci, knownBefore: false,
                profileAdmitted: product.strategy?.decisions.some(d => d.ply === job.ply && d.admitted) ?? false,
                quality: 'UNKNOWN', referenceEstimate, updates: [] };
            result.answer = answer;
            if (!manifest) { answer.error = 'NO_GRADING_CONTEXT_FROM_PAID_EVIDENCE'; }
            else {
                const node = { ...manifest.continuation.nodes[0], ply: 0 };
                const args = { manifest, node, moveUci: job.moveUci };
                const known = gradeKnownLocalMove(args);
                answer.knownBefore = known?.result.status === 'GRADED';
                const evaluated = known ?? await gradeUnknownLocalMove({ ...args, engine, signal: controller.signal,
                    planner: new AnalysisWorkPlanner({ maxNodes: Math.min(2000000, input.nodeAllowance), maxWallMs: 5000 }),
                    onUpdate: update => answer.updates.push(update) });
                answer.quality = evaluated.result.status === 'GRADED' ? evaluated.result.quality : 'UNKNOWN';
            }
        }
        if (controller.signal.aborted) throw new Error('INTERRUPTED');
        result.state = 'COMPLETED';
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.state = meter.blocked() ? 'CENSORED' : 'FAILED';
    } finally {
        raw.terminate();
        await runtime.close();
        const relativePool = path.join('evidence', `${job.id}-${input.attempt}.json`);
        atomicJson(path.join(directory, relativePool), pool.serialize());
        result.poolFile = relativePool;
        result.meter = meter.finish(result.state, result.error);
        result.state = attempt.state;
        result.error = attempt.error;
        atomicJson(input.resultPath, result);
        process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
        process.removeListener('disconnect', orphaned);
        // Per-attempt files preserve all retry costs; only this pointer is replaced.
        if (fs.existsSync(input.journalPath)) process.exitCode = result.state === 'COMPLETED' ? 0 : 2;
        if (process.connected) process.disconnect();
    }
}
