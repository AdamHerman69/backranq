/* Backranq Stockfish 18 browser bridge.
 *
 * The package's lite-single build is a raw UCI worker. This outer worker keeps
 * Backranq's structured/cancellable job protocol while the nested same-origin
 * worker runs the exact Stockfish 18 lite-single JS/WASM bundle.
 */
/* eslint-disable no-restricted-globals */

let enginePromise = null;
let engine = null;
let needsNewGameBoundary = false;
let identity = {
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
        const raw = new Worker(workerUrl);
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
            }
            if (activeJob) {
                postMessage({
                    type: 'error',
                    id: activeJob.id,
                    message,
                });
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
    };
}

function buildSnapshot(job) {
    const depthBuckets = Array.from(job.linesByDepth.entries()).sort(
        ([depthA], [depthB]) => depthB - depthA
    );
    const selectedBucket =
        depthBuckets.find(
            ([, linesAtDepth]) =>
                linesAtDepth.has(1) &&
                linesAtDepth.size >= job.multiPv
        ) ??
        depthBuckets.find(([, linesAtDepth]) => linesAtDepth.has(1));
    const lines = Array.from(selectedBucket?.[1].values() ?? [])
        .filter((line) => Array.isArray(line.pvUci) && line.pvUci.length > 0)
        .sort((left, right) => left.multipv - right.multipv);
    return {
        fen: job.fen,
        depth: selectedBucket?.[0] ?? job.lastDepth,
        selDepth: job.lastSelDepth,
        nodes: job.lastNodes,
        nps: job.lastNps,
        timeMs: job.lastTimeMs,
        lines,
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
            void startJob(next);
        }
    }, Math.max(50, timeoutMs | 0));
}

function setActive(job) {
    activeJob = {
        id: job.id,
        fen: job.fen,
        multiPv: Math.max(1, Math.min(8, job.multiPv | 0)),
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
        e.postMessage(`position fen ${j.fen}`);

        // Choose go mode.
        if (j.mode === 'nodes') {
            e.postMessage(`go nodes ${j.maxNodes}`);
        } else if (j.mode === 'depth') {
            e.postMessage(`go depth ${j.maxDepth}`);
        } else if (j.mode === 'movetime') {
            e.postMessage(`go movetime ${j.maxTimeMs}`);
        } else {
            // A long bounded search streams like interactive infinite analysis
            // while retaining a hard engine-side limit.
            const fallbackMs = 10 * 60 * 1000;
            e.postMessage(`go movetime ${fallbackMs}`);
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
            bestMoveUci: bestMoveUci || '',
            final: buildSnapshot(job),
        });
    }
    activeJob = null;
    const next = queuedStart;
    queuedStart = null;
    if (next) {
        // Fire and forget.
        void startJob(next);
    }
}

function attachEngineListener(e) {
    if (listenedEngine === e) return;
    listenedEngine = e;
    e.addMessageListener((line) => {
        if (!activeJob) return;
        if (line === 'readyok') return;

        if (line.startsWith('info ')) {
            const parsed = parseInfoLine(line);
            if (parsed.depth != null) activeJob.lastDepth = parsed.depth;
            if (parsed.selDepth != null)
                activeJob.lastSelDepth = parsed.selDepth;
            if (parsed.nodes != null) activeJob.lastNodes = parsed.nodes;
            if (parsed.nps != null) activeJob.lastNps = parsed.nps;
            if (parsed.timeMs != null) activeJob.lastTimeMs = parsed.timeMs;

            if (parsed.pvUci) {
                const depth = parsed.depth ?? activeJob.lastDepth ?? 0;
                const linesAtDepth =
                    activeJob.linesByDepth.get(depth) ?? new Map();
                const previous = linesAtDepth.get(parsed.multipv);
                if (
                    parsed.score &&
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
        const multiPv = Math.max(1, Math.min(8, Math.trunc(msg.multiPv ?? 1)));
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
