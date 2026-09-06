/** Optional local-only instrumentation for the existing quality lab. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { createStockfish18LiteEngine, type ServerStockfishRuntime } from '@/lib/analysis/serverStockfishRuntime';
import type { AnalysisLimit, StockfishEngine } from '@/lib/analysis/stockfishClient';
import type { TrainingMomentExtractionResult } from '@/lib/analysis/extractTrainingMoments';

type Call = {
    kind: 'eval' | 'multipv';
    caller: string[];
    fen: string;
    requestedNodes: number | null;
    multiPv: number;
    wallTimeMs: number;
    reportedNodes: number;
    reportedEngineTimeMs: number;
    result?: unknown;
    error?: string;
};

const auditRunId = randomUUID();

export class ExtractionQualityAudit implements StockfishEngine {
    private readonly engine: ServerStockfishClient;
    private activeCall: Call | null = null;
    private calls: Call[] = [];
    private startupMs = 0;
    private readonly started = performance.now();

    constructor(private readonly label: string) {
        this.engine = new ServerStockfishClient({ defaultTimeoutMs: 60_000,
            runtimeFactory: async () => {
                const runtime = await createStockfish18LiteEngine();
                const proxy: ServerStockfishRuntime = {
                    sendCommand: (command) => runtime.sendCommand(command),
                    terminate: () => runtime.terminate?.(),
                };
                runtime.listener = (line) => {
                    if (this.activeCall && line.startsWith('info ')) {
                        this.activeCall.reportedNodes = Math.max(this.activeCall.reportedNodes, Number(/\bnodes (\d+)/.exec(line)?.[1] ?? 0));
                        this.activeCall.reportedEngineTimeMs = Math.max(this.activeCall.reportedEngineTimeMs, Number(/\btime (\d+)/.exec(line)?.[1] ?? 0));
                    }
                    proxy.listener?.(line);
                };
                runtime.errorListener = (error) => proxy.errorListener?.(error);
                return proxy;
            },
        });
    }

    async getIdentity() {
        const started = performance.now();
        const identity = await this.engine.getIdentity();
        this.startupMs += performance.now() - started;
        return identity;
    }

    private async record<T>(kind: Call['kind'], options: AnalysisLimit & { fen: string; multiPv?: number }, operation: () => Promise<T>): Promise<T> {
        const call: Call = {
            kind, fen: options.fen, requestedNodes: options.nodes ?? null,
            multiPv: options.multiPv ?? 1, wallTimeMs: 0, reportedNodes: 0, reportedEngineTimeMs: 0,
            caller: (new Error().stack ?? '').split('\n').slice(2, 9).map((line) => line.trim().replace(/ \(.*/, '').replace(/^at /, '')),
        };
        this.calls.push(call);
        this.activeCall = call;
        const started = performance.now();
        try {
            const result = await operation();
            call.result = result;
            return result;
        } catch (error) {
            call.error = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            call.wallTimeMs = performance.now() - started;
            this.activeCall = null;
        }
    }

    evalPosition(options: AnalysisLimit & { fen: string }) {
        return this.record('eval', options, () => this.engine.evalPosition(options));
    }
    analyzeMultiPv(options: AnalysisLimit & { fen: string; multiPv?: number }) {
        return this.record('multipv', options, () => this.engine.analyzeMultiPv(options));
    }
    terminate() { this.engine.terminate(); }

    write(output: TrainingMomentExtractionResult | null, error?: unknown) {
        const totalMs = performance.now() - this.started;
        const runDirectory = process.env.BACKRANQ_EXTRACTION_AUDIT_DIRECTORY ?? 'audit';
        if (!/^[a-z0-9-]+$/i.test(runDirectory)) throw new Error('Invalid audit directory name');
        const directory = path.resolve('artifacts/extraction-quality-lab', runDirectory);
        fs.mkdirSync(directory, { recursive: true });
        const corpus = fs.readFileSync('tests/fixtures/training-v2/real-games.corpus.v1.json');
        fs.writeFileSync(path.join(directory, `${this.label.replace(/[^a-z0-9.-]/gi, '_')}.json`), JSON.stringify({
            generatedAt: new Date().toISOString(),
            auditRunId,
            head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memory: os.totalmem() },
            corpusSha256: createHash('sha256').update(corpus).digest('hex'),
            startupMs: this.startupMs, totalMs,
            telemetryNote: 'reportedNodes is maximum UCI info nodes per search (not sum of MultiPV slots); final info can precede actual stop. Caller stack is diagnostic only. Full extraction includes no database/provider writes.',
            calls: this.calls,
            output: output ? { ...output, analysis: output.analysis ? Object.fromEntries(output.analysis) : null } : null,
            error: error == null ? null : String(error),
        }, null, 2) + '\n');
    }
}
