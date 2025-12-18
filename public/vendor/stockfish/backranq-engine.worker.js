/* backranq Stockfish engine wrapper worker
 *
 * Runs stockfish.wasm (Emscripten build) inside THIS worker, and bridges UCI I/O
 * back to the main thread with throttled, incremental MultiPV updates.
 *
 * Note: This worker MUST live next to stockfish.js/stockfish.wasm/stockfish.worker.js
 * so Emscripten locateFile resolves those assets correctly.
 */
/* eslint-disable no-restricted-globals */
/* global Stockfish */

let enginePromise = null;
let engine = null;

function ensureEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
        // Relative import keeps Emscripten asset resolution inside /vendor/stockfish/.
        importScripts('stockfish.js');
        // Emscripten pthread workers need a concrete main script URL.
        // When loaded via importScripts() inside a worker, Stockfish's internal
        // `_scriptDir` can be undefined, which can cause it to pass an invalid
        // `urlOrBlob` to pthread bootstrap (and crash with createObjectURL()).
        const mainScriptUrl = new URL(
            'stockfish.js',
            self.location.href
        ).toString();
        const e = await Stockfish({ mainScriptUrlOrBlob: mainScriptUrl });
        engine = e;
        // Bootstrap UCI.
        e.postMessage('uci');
        e.postMessage('isready');
        return e;
    })();
    return enginePromise;
}

function parseInfoLine(line) {
    // Returns a partial parse; any missing fields are left undefined/null.
    const depth = /\bdepth\s+(\d+)\b/.exec(line);
    const time = /\btime\s+(\d+)\b/.exec(line);
    const multipv = /\bmultipv\s+(\d+)\b/.exec(line);
    const scoreMate = /\bscore\s+mate\s+(-?\d+)\b/.exec(line);
    const scoreCp = /\bscore\s+cp\s+(-?\d+)\b/.exec(line);
    const pv = /\bpv\s+(.+)\s*$/.exec(line);

    return {
        depth: depth ? Number(depth[1]) : undefined,
        timeMs: time ? Number(time[1]) : undefined,
        multipv: multipv ? Number(multipv[1]) : 1,
        score: scoreMate
            ? { type: 'mate', value: Number(scoreMate[1]) }
            : scoreCp
            ? { type: 'cp', value: Number(scoreCp[1]) }
            : null,
        pvUci: pv ? pv[1].trim().split(/\s+/).filter(Boolean) : null,
    };
}

function buildSnapshot(job) {
    const lines = Array.from(job.linesByMultiPv.values())
        .filter((l) => Array.isArray(l.pvUci) && l.pvUci.length > 0)
        .sort((a, b) => a.multipv - b.multipv);
    return {
        fen: job.fen,
        depth: job.lastDepth,
        timeMs: job.lastTimeMs,
        lines,
    };
}

let activeJob = null; // { id, fen, multiPv, minDepth, maxDepth, maxTimeMs, emitIntervalMs, mode, ... }
let queuedStart = null; // job args to start after activeJob ends
let forceStopTimer = null;
let forceStopForJobId = null;

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

        // Abandon the stuck job without attributing a late "bestmove" to the next job.
        activeJob = null;

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
        multiPv: Math.max(1, Math.min(5, job.multiPv | 0)),
        minDepth:
            job.minDepth == null ? null : Math.max(1, Math.trunc(job.minDepth)),
        maxDepth:
            job.maxDepth == null ? null : Math.max(1, Math.trunc(job.maxDepth)),
        maxTimeMs:
            job.maxTimeMs == null
                ? null
                : Math.max(1, Math.trunc(job.maxTimeMs)),
        emitIntervalMs: Math.max(50, Math.trunc(job.emitIntervalMs ?? 150)),
        mode: job.mode,
        linesByMultiPv: new Map(),
        lastDepth: undefined,
        lastTimeMs: undefined,
        lastEmitAt: 0,
        stopRequested: false,
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
    const e = await ensureEngine();
    clearForceStopTimer();
    setActive(job);
    const j = activeJob;
    if (!j) return;

    // Ensure the engine is in a clean state.
    e.postMessage('stop');
    e.postMessage('ucinewgame');
    e.postMessage('isready');
    e.postMessage(`setoption name MultiPV value ${j.multiPv}`);
    e.postMessage(`position fen ${j.fen}`);

    // Choose go mode.
    if (j.mode === 'depth') {
        e.postMessage(`go depth ${j.maxDepth}`);
    } else if (j.mode === 'movetime') {
        e.postMessage(`go movetime ${j.maxTimeMs}`);
    } else {
        // Some Stockfish WASM builds/browsers are flaky with `go infinite` and may
        // not emit incremental `info pv ...` lines reliably.
        //
        // Using a large movetime behaves like "infinite" for UI purposes (user
        // stops/position changes), while staying on the well-trodden codepath
        // that streams PV updates.
        //
        // 10 minutes is effectively infinite for interactive analysis.
        const fallbackMs = 10 * 60 * 1000;
        e.postMessage(`go movetime ${fallbackMs}`);
    }
}

async function requestStart(job) {
    // Serialize jobs so "bestmove" can't be misattributed.
    if (activeJob) {
        queuedStart = job;
        if (!activeJob.stopRequested) {
            activeJob.stopRequested = true;
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
        queuedStart = null;
        return;
    }
    if (!activeJob || activeJob.id !== id) return;
    activeJob.stopRequested = true;
    const e = await ensureEngine();
    e.postMessage('stop');
    // If stop doesn't yield a bestmove, force-clear the job.
    scheduleForceStop(600);
}

function finishJob(bestMoveUci) {
    if (!activeJob) return;
    const job = activeJob;
    clearForceStopTimer();
    emitUpdate(job, true);
    postMessage({
        type: 'done',
        id: job.id,
        bestMoveUci: bestMoveUci || '',
        final: buildSnapshot(job),
    });
    activeJob = null;
    const next = queuedStart;
    queuedStart = null;
    if (next) {
        // Fire and forget.
        void startJob(next);
    }
}

function attachEngineListenerOnce() {
    if (attachEngineListenerOnce._attached) return;
    attachEngineListenerOnce._attached = true;
    void ensureEngine().then((e) => {
        e.addMessageListener((line) => {
            if (!activeJob) return;
            if (line === 'readyok') return;

            if (line.startsWith('info ')) {
                const parsed = parseInfoLine(line);
                if (parsed.depth != null) activeJob.lastDepth = parsed.depth;
                if (parsed.timeMs != null) activeJob.lastTimeMs = parsed.timeMs;

                if (parsed.pvUci) {
                    activeJob.linesByMultiPv.set(parsed.multipv, {
                        multipv: parsed.multipv,
                        score: parsed.score,
                        pvUci: parsed.pvUci,
                    });
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
    });
}
attachEngineListenerOnce._attached = false;

self.onmessage = (ev) => {
    const msg = ev.data || {};
    if (!msg || typeof msg !== 'object') return;
    attachEngineListenerOnce();

    if (msg.type === 'start') {
        const multiPv = Math.max(1, Math.min(5, Math.trunc(msg.multiPv ?? 1)));
        const maxDepth =
            msg.maxDepth == null ? null : Math.max(1, Math.trunc(msg.maxDepth));
        const maxTimeMs =
            msg.maxTimeMs == null
                ? null
                : Math.max(1, Math.trunc(msg.maxTimeMs));
        const mode =
            maxDepth != null && maxTimeMs != null
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
    }
};
