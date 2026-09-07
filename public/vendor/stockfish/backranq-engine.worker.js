/* Backranq Stockfish 18 browser bridge.
 *
 * The package's lite-single build is a raw UCI worker. This outer worker keeps
 * Backranq's structured/cancellable job protocol while the nested same-origin
 * worker runs the exact Stockfish 18 lite-single JS/WASM bundle.
 */
/* eslint-disable no-restricted-globals */

let enginePromise = null;
let engine = null;
let engineSessionId = null;
let needsNewGameBoundary = false;
const runtimeRevision = 'stockfish-18.0.8-bridge-v8';
let identity = {
    artifactId: 'stockfish-js-wasm-sha256:5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391:a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1',
    name: 'Stockfish 18',
    version: '18.0.8',
    flavor: 'lite-single-nnue-wasm',
    source: 'stockfish@18.0.8/browser/stockfish-18-lite-single',
    options: {
        Threads: 1,
        Hash: 64,
        UCI_ShowWDL: true,
    },
};

function ensureEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = new Promise((resolve, reject) => {
        const workerUrl = new URL(
            'stockfish-18-lite-single.js',
            self.location.href
        );
        workerUrl.searchParams.set('v', runtimeRevision);
        const wasmUrl = new URL(
            'stockfish-18-lite-single.wasm',
            self.location.href
        );
        wasmUrl.searchParams.set('v', runtimeRevision);
        // The packaged Emscripten worker reads its explicit WASM URL from the
        // hash. Versioning both nested requests makes immutable HTTP caching
        // safe and keeps the service-worker runtime cache internally coherent.
        workerUrl.hash = encodeURIComponent(wasmUrl.href);
        const raw = new Worker(workerUrl);
        engineSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const listeners = new Set();
        const protocolWaiters = new Set();
        let ready = false;
        let startupSettled = false;
        const startupTimeout = setTimeout(() => {
            failStartup(
                new Error('Stockfish 18 browser worker startup timed out')
            );
        }, 20_000);
        function failStartup(error) {
            if (startupSettled) return;
            startupSettled = true;
            clearTimeout(startupTimeout);
            for (const waiter of protocolWaiters) {
                clearTimeout(waiter.timeout);
                waiter.reject(error);
            }
            protocolWaiters.clear();
            raw.terminate();
            reject(error);
        }
        const adapter = {
            postMessage(command) {
                raw.postMessage(command);
            },
            addMessageListener(listener) {
                listeners.add(listener);
            },
            waitForProtocolLine(predicate, timeoutMs, label) {
                return new Promise((waitResolve, waitReject) => {
                    const waiter = {
                        predicate,
                        resolve: waitResolve,
                        reject: waitReject,
                        timeout: null,
                    };
                    waiter.timeout = setTimeout(() => {
                        protocolWaiters.delete(waiter);
                        waitReject(
                            new Error(`Engine did not return ${label}`)
                        );
                    }, timeoutMs);
                    protocolWaiters.add(waiter);
                });
            },
            async waitUntilReady() {
                const readyLine = adapter.waitForProtocolLine(
                    (line) => line === 'readyok',
                    10_000,
                    'readyok'
                );
                raw.postMessage('isready');
                await readyLine;
            },
            terminate() {
                for (const waiter of protocolWaiters) {
                    clearTimeout(waiter.timeout);
                    waiter.reject(new Error('Engine terminated'));
                }
                protocolWaiters.clear();
                raw.terminate();
            },
        };
        raw.onmessage = (event) => {
            const line = String(event.data ?? '');
            if (line.startsWith('id name ')) {
                identity = {
                    ...identity,
                    name: line.slice('id name '.length).trim(),
                };
            } else if (line.startsWith('id author ')) {
                identity = {
                    ...identity,
                    author: line.slice('id author '.length).trim(),
                };
            } else {
                const evalFile =
                    /^option name EvalFile type string default (.+)$/.exec(
                        line
                    )?.[1];
                if (evalFile) {
                    identity = {
                        ...identity,
                        evalFile: evalFile.trim(),
                    };
                }
            }
            if (line === 'uciok') {
                postMessage({ type: 'identity', identity });
            }
            for (const waiter of protocolWaiters) {
                if (!waiter.predicate(line)) continue;
                clearTimeout(waiter.timeout);
                protocolWaiters.delete(waiter);
                waiter.resolve(line);
            }
            for (const listener of listeners) listener(line);
        };
        raw.onerror = (event) => {
            const message =
                event && event.message
                    ? `${event.message} (${event.filename || 'worker'}:${
                          event.lineno || 0
                      }:${event.colno || 0})`
                    : 'Stockfish 18 browser worker crashed';
            if (!ready) {
                failStartup(new Error(message));
            } else if (engine !== adapter) {
                return;
            }
            if (activeJob) {
                postMessage({
                    type: 'error',
                    id: activeJob.id,
                    message,
                });
            }
            if (ready) {
                clearForceStopTimer();
                adapter.terminate();
                engine = null;
                enginePromise = null;
                listenedEngine = null;
                activeJob = null;
                const next = queuedStart;
                queuedStart = null;
                if (next) void startJob(next).catch((error) => postMessage({ type: 'error', id: next.id, message: String(error) }));
            }
        };
        void (async () => {
            const uciOk = adapter.waitForProtocolLine(
                (line) => line === 'uciok',
                10_000,
                'uciok'
            );
            raw.postMessage('uci');
            await uciOk;
            raw.postMessage('setoption name Threads value 1');
            raw.postMessage('setoption name Hash value 64');
            raw.postMessage('setoption name UCI_ShowWDL value true');
            // Explicit engine-session boundary. Normal searches below reuse the
            // hash; a forced cancellation reset creates a fresh raw worker and
            // repeats this startup sequence.
            raw.postMessage('ucinewgame');
            await adapter.waitUntilReady();
            needsNewGameBoundary = false;
            ready = true;
            startupSettled = true;
            clearTimeout(startupTimeout);
            engine = adapter;
            resolve(adapter);
        })().catch((error) => {
            failStartup(
                error instanceof Error ? error : new Error(String(error))
            );
        });
    });
    enginePromise.catch(() => {
        engine = null;
        enginePromise = null;
    });
    return enginePromise;
}

function parseInfoLine(line) {
    // Returns a partial parse; any missing fields are left undefined/null.
    const depth = /\bdepth\s+(\d+)\b/.exec(line);
    const selDepth = /\bseldepth\s+(\d+)\b/.exec(line);
    const nodes = /\bnodes\s+(\d+)\b/.exec(line);
    const nps = /\bnps\s+(\d+)\b/.exec(line);
    const time = /\btime\s+(\d+)\b/.exec(line);
    const multipv = /\bmultipv\s+(\d+)\b/.exec(line);
    const scoreMate = /\bscore\s+mate\s+(-?\d+)\b/.exec(line);
    const scoreCp = /\bscore\s+cp\s+(-?\d+)\b/.exec(line);
    const pv = /\bpv\s+(.+)\s*$/.exec(line);
    const wdl = /\bwdl\s+(\d+)\s+(\d+)\s+(\d+)\b/.exec(line);
    const isBound = /\b(?:lowerbound|upperbound)\b/.test(line);
    const boundedScore = scoreMate ? { type: 'mate', value: Number(scoreMate[1]) } : scoreCp ? { type: 'cp', value: Number(scoreCp[1]) } : null;

    return {
        depth: depth ? Number(depth[1]) : undefined,
        selDepth: selDepth ? Number(selDepth[1]) : undefined,
        nodes: nodes ? Number(nodes[1]) : undefined,
        nps: nps ? Number(nps[1]) : undefined,
        timeMs: time ? Number(time[1]) : undefined,
        multipv: multipv ? Number(multipv[1]) : 1,
        score: isBound
            ? null
            : scoreMate
            ? { type: 'mate', value: Number(scoreMate[1]) }
            : scoreCp
            ? { type: 'cp', value: Number(scoreCp[1]) }
            : null,
        wdl: wdl
            ? {
                  win: Number(wdl[1]),
                  draw: Number(wdl[2]),
                  loss: Number(wdl[3]),
              }
            : undefined,
        pvUci: pv ? pv[1].trim().split(/\s+/).filter(Boolean) : null,
        boundedScore: isBound ? boundedScore : null,
        bound: isBound ? (/\bupperbound\b/.test(line) ? 'UPPER' : 'LOWER') : null,
    };
}

function normalizeRootMoves(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
        throw new Error(
            'Restricted Stockfish search requires a nonempty root scope of at most 256 moves'
        );
    }
    const seen = new Set();
    return value.map((rawMove) => {
        const move = String(rawMove).trim().toLowerCase();
        if (
            !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ||
            seen.has(move)
        ) {
            throw new Error(
                'Restricted Stockfish root moves must be unique exact UCI moves'
            );
        }
        seen.add(move);
        return move;
    });
}

function validCompleteLines(job, lines) {
    const expected = Math.min(job.multiPv, job.legalRootMoves?.length ?? job.multiPv);
    const roots = new Set();
    if (lines.length !== expected) return false;
    return lines.every((line, index) => {
        const root = line.pvUci?.[0];
        if (line.multipv !== index + 1 || !line.score || !Number.isFinite(line.score.value) || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(root ?? '') || roots.has(root) || (job.legalRootMoves && !job.legalRootMoves.includes(root))) return false;
        roots.add(root);
        return true;
    });
}

function retainEvidenceSnapshots(snapshots) {
    const points = new Map();
    const bounds = new Map();
    for (const snapshot of snapshots) for (const line of snapshot.lines) {
        const move = line.pvUci[0];
        if (snapshot.bundleComplete) {
            points.set(move, [...(points.get(move) ?? []), snapshot].slice(-3));
            bounds.delete(move);
        } else {
            const active = bounds.get(move) ?? new Map();
            const key = `${line.bound}:${line.score.type}:${line.score.type === 'mate' ? Math.sign(line.score.value) : ''}`;
            const previous = active.get(key);
            if (!previous || line.score.type !== 'cp' ||
                (line.bound === 'LOWER' ? line.score.value >= previous.line.score.value : line.score.value <= previous.line.score.value)) {
                active.set(key, { snapshot, line });
            }
            bounds.set(move, active);
        }
    }
    const retained = new Set([...points.values()].flat());
    for (const active of bounds.values()) for (const item of active.values()) retained.add(item.snapshot);
    return snapshots.filter(snapshot => retained.has(snapshot));
}

function buildSnapshot(job) {
    const depthBuckets = Array.from(job.linesByDepth.entries()).sort(
        ([depthA], [depthB]) => depthB - depthA
    );
    const selectedBucket =
        depthBuckets.find(
            ([, linesAtDepth]) =>
                validCompleteLines(job, Array.from(linesAtDepth.values()).sort((a, b) => a.multipv - b.multipv))
        ) ??
        depthBuckets.find(([, linesAtDepth]) => linesAtDepth.has(1));
    let lines = Array.from(selectedBucket?.[1].values() ?? [])
        .filter((line) => Array.isArray(line.pvUci) && line.pvUci.length > 0)
        .sort((left, right) => left.multipv - right.multipv);
    let depth = selectedBucket?.[0] ?? job.lastDepth;
    if (job.completeSnapshot && (!validCompleteLines(job, lines) || job.completeSnapshot.depth >= depth)) {
        lines = job.completeSnapshot.lines;
        depth = job.completeSnapshot.depth;
    }
    return {
        fen: job.fen,
        depth,
        selDepth: job.lastSelDepth,
        nodes: job.lastNodes,
        nps: job.lastNps,
        timeMs: job.lastTimeMs,
        lines,
        boundLines: Array.from(job.boundLines?.values() ?? []),
    };
}

let activeJob = null; // { id, fen, multiPv, minDepth, maxDepth, maxTimeMs, emitIntervalMs, mode, ... }
let queuedStart = null; // job args to start after activeJob ends
let forceStopTimer = null;
let forceStopForJobId = null;
let listenedEngine = null;

function clearForceStopTimer() {
    if (forceStopTimer) clearTimeout(forceStopTimer);
    forceStopTimer = null;
    forceStopForJobId = null;
}

function scheduleForceStop(timeoutMs) {
    // If Stockfish doesn't emit "bestmove" after "stop", jobs can get stuck forever.
    // This watchdog force-clears the active job so queued jobs can start.
    if (!activeJob) return;
    if (!activeJob.stopRequested) return;
    clearForceStopTimer();
    forceStopForJobId = activeJob.id;
    forceStopTimer = setTimeout(() => {
        // Only force-stop if we're still on the same job and it's still stopped.
        if (!activeJob) return;
        if (activeJob.id !== forceStopForJobId) return;
        if (!activeJob.stopRequested) return;

        // A late bestmove from an abandoned search must never finish the next
        // job. Recreate the raw UCI runtime before starting queued work.
        const staleEngine = engine;
        const cancelledJob = activeJob;
        engine = null;
        enginePromise = null;
        listenedEngine = null;
        staleEngine?.terminate();
        activeJob = null;
        if (cancelledJob.cancelReason) {
            postMessage({
                type: 'cancelled',
                id: cancelledJob.id,
                message: cancelledJob.cancelReason,
            });
        }

        const next = queuedStart;
        queuedStart = null;
        if (next) {
            void startJob(next).catch((error) => postMessage({ type: 'error', id: next.id, message: String(error) }));
        }
    }, Math.max(50, timeoutMs | 0));
}

function setActive(job) {
    activeJob = {
        id: job.id,
        fen: job.fen,
        multiPv: Math.max(1, Math.min(16, job.multiPv | 0)),
        rootMoves: job.rootMoves,
        legalRootMoves: job.legalRootMoves,
        positionCommand: job.positionCommand,
        completeSnapshot: null,
        snapshots: [],
        snapshotIndex: 0,
        boundLines: new Map(),
        minDepth:
            job.minDepth == null ? null : Math.max(1, Math.trunc(job.minDepth)),
        maxDepth:
            job.maxDepth == null ? null : Math.max(1, Math.trunc(job.maxDepth)),
        maxNodes:
            job.maxNodes == null ? null : Math.max(1, Math.trunc(job.maxNodes)),
        maxTimeMs:
            job.maxTimeMs == null
                ? null
                : Math.max(1, Math.trunc(job.maxTimeMs)),
        emitIntervalMs: Math.max(50, Math.trunc(job.emitIntervalMs ?? 150)),
        mode: job.mode,
        linesByDepth: new Map(),
        lastDepth: undefined,
        lastSelDepth: undefined,
        lastNodes: undefined,
        lastNps: undefined,
        lastTimeMs: undefined,
        lastEmitAt: 0,
        stopRequested: false,
        cancelReason: null,
    };
}

function shouldEmit(job) {
    if (job.minDepth != null) {
        const d = job.lastDepth ?? 0;
        if (d < job.minDepth) return false;
    }
    return true;
}

function emitUpdate(job, force) {
    if (!job) return;
    if (!shouldEmit(job)) return;
    const now = Date.now();
    if (!force && now - job.lastEmitAt < job.emitIntervalMs) return;
    job.lastEmitAt = now;
    postMessage({
        type: 'update',
        id: job.id,
        update: buildSnapshot(job),
    });
}

async function startJob(job) {
    clearForceStopTimer();
    setActive(job);
    const j = activeJob;
    if (!j) return;

    try {
        const e = await ensureEngine();
        attachEngineListener(e);
        if (!activeJob || activeJob.id !== j.id || j.stopRequested) return;

        // Retain the transposition table across related positions. The ready
        // barrier still guarantees this search's MultiPV option is applied
        // before `position`/`go`.
        if (needsNewGameBoundary) {
            e.postMessage('ucinewgame');
            needsNewGameBoundary = false;
        }
        e.postMessage(`setoption name MultiPV value ${j.multiPv}`);
        await e.waitUntilReady();
        if (!activeJob || activeJob.id !== j.id || j.stopRequested) return;
        e.postMessage(j.positionCommand ?? `position fen ${j.fen}`);
        const searchMoves =
            j.rootMoves && j.rootMoves.length > 0
                ? ` searchmoves ${j.rootMoves.join(' ')}`
                : '';

        // Choose go mode.
        if (j.mode === 'nodes') {
            e.postMessage(`go nodes ${j.maxNodes}${searchMoves}`);
        } else if (j.mode === 'depth') {
            e.postMessage(`go depth ${j.maxDepth}${searchMoves}`);
        } else if (j.mode === 'movetime') {
            e.postMessage(`go movetime ${j.maxTimeMs}${searchMoves}`);
        } else {
            // A long bounded search streams like interactive infinite analysis
            // while retaining a hard engine-side limit.
            const fallbackMs = 10 * 60 * 1000;
            e.postMessage(`go movetime ${fallbackMs}${searchMoves}`);
        }
    } catch (error) {
        if (activeJob?.id === j.id) activeJob = null;
        throw error;
    }
}

async function requestStart(job) {
    // Serialize jobs so "bestmove" can't be misattributed.
    if (activeJob) {
        if (queuedStart && queuedStart.id !== job.id) {
            postMessage({
                type: 'cancelled',
                id: queuedStart.id,
                message: 'Analysis superseded by a newer search',
            });
        }
        queuedStart = job;
        if (!activeJob.stopRequested) {
            activeJob.stopRequested = true;
            activeJob.cancelReason =
                'Analysis superseded by a newer search';
            needsNewGameBoundary = true;
            const e = await ensureEngine();
            e.postMessage('stop');
        }
        // If stop doesn't result in a bestmove, unstick after a short delay.
        scheduleForceStop(600);
        return;
    }
    queuedStart = null;
    await startJob(job);
}

async function requestStop(id) {
    // If the job hasn't started yet (it's queued), cancel it here.
    if (queuedStart && queuedStart.id === id) {
        postMessage({
            type: 'cancelled',
            id,
            message: 'Analysis cancelled',
        });
        queuedStart = null;
        return;
    }
    if (!activeJob || activeJob.id !== id) return;
    activeJob.stopRequested = true;
    activeJob.cancelReason = 'Analysis cancelled';
    needsNewGameBoundary = true;
    const e = await ensureEngine();
    e.postMessage('stop');
    // If stop doesn't yield a bestmove, force-clear the job.
    scheduleForceStop(600);
}

function finishJob(bestMoveUci) {
    if (!activeJob) return;
    const job = activeJob;
    clearForceStopTimer();
    if (job.cancelReason) {
        postMessage({
            type: 'cancelled',
            id: job.id,
            message: job.cancelReason,
        });
    } else {
        emitUpdate(job, true);
        postMessage({
            type: 'done',
            id: job.id,
            sessionId: engineSessionId,
            bestMoveUci: bestMoveUci || '',
            final: buildSnapshot(job),
        });
    }
    activeJob = null;
    const next = queuedStart;
    queuedStart = null;
    if (next) {
        // Fire and forget.
        void startJob(next).catch((error) => postMessage({ type: 'error', id: next.id, message: String(error) }));
    }
}

function attachEngineListener(e) {
    if (listenedEngine === e) return;
    listenedEngine = e;
    e.addMessageListener((line) => {
        if (!activeJob || e !== engine) return;
        if (line === 'readyok') return;
        if (activeJob.cancelReason && !line.startsWith('bestmove ')) return;

        if (line.startsWith('info ')) {
            const parsed = parseInfoLine(line);
            if (parsed.depth != null) activeJob.lastDepth = parsed.depth;
            if (parsed.selDepth != null)
                activeJob.lastSelDepth = parsed.selDepth;
            if (parsed.nodes != null) activeJob.lastNodes = Math.max(activeJob.lastNodes ?? 0, parsed.nodes);
            if (parsed.nps != null) activeJob.lastNps = parsed.nps;
            if (parsed.timeMs != null) activeJob.lastTimeMs = Math.max(activeJob.lastTimeMs ?? 0, parsed.timeMs);
            const boundedRoot = parsed.pvUci?.[0];
            if (parsed.boundedScore && parsed.bound && boundedRoot && (!activeJob.legalRootMoves || activeJob.legalRootMoves.includes(boundedRoot))) {
                for (const bucket of activeJob.linesByDepth.values()) for (const [slot, point] of bucket) {
                    if (point.pvUci[0] === boundedRoot) bucket.delete(slot);
                }
                if (parsed.depth != null) activeJob.linesByDepth.get(parsed.depth)?.delete(parsed.multipv);
                activeJob.boundLines.set(boundedRoot, { moveUci: boundedRoot, score: parsed.boundedScore, bound: parsed.bound, depth: parsed.depth, nodes: parsed.nodes, timeMs: parsed.timeMs });
                if (Number.isInteger(parsed.depth) && parsed.depth > 0) {
                    const snapshot = { snapshotIndex: activeJob.snapshotIndex++, depth: parsed.depth, bundleComplete: false,
                        lines: [{ multipv: parsed.multipv, score: parsed.boundedScore, bound: parsed.bound, pvUci: parsed.pvUci,
                            depth: parsed.depth, nodes: parsed.nodes, timeMs: parsed.timeMs, wdl: parsed.wdl }] };
                    activeJob.snapshots = retainEvidenceSnapshots([...activeJob.snapshots, snapshot]);
                    postMessage({ type: 'snapshot', id: activeJob.id, sessionId: engineSessionId, snapshot });
                }
            }

            if (parsed.pvUci) {
                const depth = parsed.depth ?? activeJob.lastDepth ?? 0;
                const linesAtDepth =
                    activeJob.linesByDepth.get(depth) ?? new Map();
                const previous = linesAtDepth.get(parsed.multipv);
                if (
                    parsed.score &&
                    parsed.depth != null &&
                    (!previous ||
                        (parsed.depth ?? 0) >= (previous.depth ?? 0))
                ) {
                    linesAtDepth.set(parsed.multipv, {
                        multipv: parsed.multipv,
                        score: parsed.score,
                        wdl: parsed.wdl,
                        pvUci: parsed.pvUci,
                        depth: parsed.depth,
                        selDepth: parsed.selDepth,
                        nodes: parsed.nodes,
                        nps: parsed.nps,
                        timeMs: parsed.timeMs,
                    });
                    activeJob.linesByDepth.set(depth, linesAtDepth);
                    const completeLines = Array.from(linesAtDepth.values()).sort((a, b) => a.multipv - b.multipv);
                    if (validCompleteLines(activeJob, completeLines) && (!activeJob.completeSnapshot || depth >= activeJob.completeSnapshot.depth)) {
                        activeJob.completeSnapshot = { depth, lines: completeLines };
                        const previousSnapshot = activeJob.snapshots.findLast(snapshot => snapshot.bundleComplete);
                        const semanticBundle = (lines) => JSON.stringify(lines.map(line => [line.multipv, line.score, line.wdl, line.pvUci, line.depth]));
                        if (!previousSnapshot || semanticBundle(completeLines) !== semanticBundle(previousSnapshot.lines)
                            || completeLines.some(line => activeJob.boundLines.has(line.pvUci[0]))) {
                            const snapshot = { snapshotIndex: activeJob.snapshotIndex++, depth, lines: completeLines, bundleComplete: true };
                            activeJob.snapshots.push(snapshot);
                            activeJob.snapshots = retainEvidenceSnapshots(activeJob.snapshots);
                            for (const line of completeLines) activeJob.boundLines.delete(line.pvUci[0]);
                            postMessage({ type: 'snapshot', id: activeJob.id, sessionId: engineSessionId, snapshot });
                        }
                        for (const key of activeJob.linesByDepth.keys()) if (key < depth - 2) activeJob.linesByDepth.delete(key);
                    }
                }
            }

            // Stop conditions for infinite mode (when caller provided both limits).
            if (activeJob.mode === 'infinite' && !activeJob.stopRequested) {
                const d = activeJob.lastDepth ?? 0;
                const t = activeJob.lastTimeMs ?? 0;
                if (
                    (activeJob.maxDepth != null &&
                        d >= activeJob.maxDepth) ||
                    (activeJob.maxTimeMs != null &&
                        t >= activeJob.maxTimeMs)
                ) {
                    activeJob.stopRequested = true;
                    e.postMessage('stop');
                }
            }

            emitUpdate(activeJob, false);
            return;
        }

        if (line.startsWith('bestmove ')) {
            const best = (line.split(/\s+/)[1] ?? '').trim();
            finishJob(best);
        }
    });
}

self.onmessage = (ev) => {
    const msg = ev.data || {};
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'start') {
        let rootMoves;
        try {
            rootMoves = normalizeRootMoves(msg.rootMoves);
        } catch (error) {
            postMessage({
                type: 'error',
                id: String(msg.id ?? ''),
                message:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
            return;
        }
        const multiPv = Math.max(
            1,
            Math.min(
                rootMoves?.length ?? 16,
                16,
                Math.trunc(msg.multiPv ?? 1)
            )
        );
        const maxDepth =
            msg.maxDepth == null ? null : Math.max(1, Math.trunc(msg.maxDepth));
        const maxNodes =
            msg.maxNodes == null ? null : Math.max(1, Math.trunc(msg.maxNodes));
        const maxTimeMs =
            msg.maxTimeMs == null
                ? null
                : Math.max(1, Math.trunc(msg.maxTimeMs));
        const mode =
            maxNodes != null
                ? 'nodes'
                : maxDepth != null && maxTimeMs != null
                ? 'infinite'
                : maxDepth != null
                ? 'depth'
                : maxTimeMs != null
                ? 'movetime'
                : 'infinite';

        void requestStart({
            id: String(msg.id ?? ''),
            fen: String(msg.fen ?? ''),
            multiPv,
            minDepth: msg.minDepth ?? null,
            maxDepth,
            maxNodes,
            maxTimeMs,
            emitIntervalMs: msg.emitIntervalMs ?? 150,
            rootMoves,
            legalRootMoves: Array.isArray(msg.legalRootMoves) ? msg.legalRootMoves : rootMoves,
            positionCommand: typeof msg.positionCommand === 'string' ? msg.positionCommand : undefined,
            mode,
        }).catch((err) => {
            postMessage({
                type: 'error',
                id: String(msg.id ?? ''),
                message: err instanceof Error ? err.message : String(err),
            });
        });
    } else if (msg.type === 'stop') {
        void requestStop(String(msg.id ?? '')).catch((err) => {
            postMessage({
                type: 'error',
                id: String(msg.id ?? ''),
                message: err instanceof Error ? err.message : String(err),
            });
        });
    } else if (msg.type === 'identity') {
        void ensureEngine()
            .then(() => {
                postMessage({ type: 'identity', identity });
            })
            .catch((err) => {
                postMessage({
                    type: 'error',
                    id: '',
                    message:
                        err instanceof Error ? err.message : String(err),
                });
            });
    }
};
