import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';

export function studyRuntime() {
    const meters: Array<{ cpu: number; rss: number }> = [];
    const exits: Promise<void>[] = [];
    return {
        cpuSeconds: () => meters.reduce((n, m) => n + m.cpu, 0),
        maxRssBytes: () => meters.reduce((n, m) => n + m.rss, 0),
        close: () => Promise.all(exits),
        factory: async (): Promise<ServerStockfishRuntime> => {
            const usage = { cpu: 0, rss: 0 }; meters.push(usage);
            const child = spawn(process.execPath, ['--import', path.resolve('scripts/extractor-study/cpu-hook.mjs'),
                path.resolve('src/lib/analysis/serverStockfishProcess.mjs')], {
                env: { ...process.env, BACKRANQ_STOCKFISH_WASM_PATH: path.resolve('node_modules/stockfish/bin/stockfish-18-lite-single.wasm') },
                stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            });
            exits.push(new Promise(resolve => child.once('close', () => resolve())));
            let terminated = false;
            const runtime: ServerStockfishRuntime = {
                sendCommand(command) {
                    if (terminated || !child.connected) throw new Error('Study engine process terminated');
                    child.send({ type: 'command', command });
                },
                terminate() { if (!terminated) { terminated = true; child.kill('SIGTERM'); } },
            };
            await new Promise<void>((resolve, reject) => {
                let ready = false;
                const timer = setTimeout(() => { runtime.terminate?.(); reject(new Error('Study engine startup timeout')); }, 20000);
                const fail = (error: Error) => {
                    clearTimeout(timer);
                    if (!ready) reject(error); else if (!terminated) runtime.errorListener?.(error);
                    runtime.terminate?.();
                };
                child.on('message', (raw: unknown) => {
                    const message = raw as { type: string; line?: string; error?: string; cpuSeconds?: number; maxRssBytes?: number };
                    if (message.type === 'study-cpu') {
                        if (typeof message.cpuSeconds === 'number' && Number.isFinite(message.cpuSeconds)) usage.cpu = Math.max(usage.cpu, message.cpuSeconds);
                        if (typeof message.maxRssBytes === 'number' && Number.isFinite(message.maxRssBytes)) usage.rss = Math.max(usage.rss, message.maxRssBytes);
                    } else if (message.type === 'ready') { ready = true; clearTimeout(timer); resolve(); }
                    else if (message.type === 'line' && typeof message.line === 'string') runtime.listener?.(message.line);
                    else if (message.type === 'fatal') fail(new Error(message.error ?? 'Engine fatal error'));
                });
                child.once('error', fail);
                child.once('exit', (code, signal) => { if (!terminated) fail(new Error(`Study engine exit ${signal ?? code}`)); });
            });
            return runtime;
        },
    };
}
