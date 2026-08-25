import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import type { StockfishClient } from '@/lib/analysis/stockfishClient';
import type { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import type { TrainingMomentExtractionOptions } from '@/lib/analysis/extractTrainingMoments';
import { gameSourceToUi, timeClassToUi } from '@/lib/games/dbMappings';
import type { GameSource, TimeClass } from '@prisma/client';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import type {
    AnalysisDefaults,
    PreferencesSchema,
} from '@/lib/preferences';
import type { AnalysisQuality } from '@/lib/analysis/quality';
import {
    clearLastAnalysisCompletion,
    createBrowserAnalysisCompletion,
    publishAnalysisCompletion,
    publishLibraryChanged,
    type AnalysisCompletionSummary,
} from '@/lib/analysis/analysisCompletion';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

export type BackgroundAnalysisSnapshot = {
    ownerId: string | null;
    state: 'idle' | 'running' | 'error';
    percent: number; // 0..100
    label: string;
    totalGames: number;
    completedGames: number;
    queuedGames: number;
    pendingUnanalyzedCount: number | null;
    lastError: string | null;
    lastCompletion: AnalysisCompletionSummary | null;
};

type Listener = (s: BackgroundAnalysisSnapshot) => void;

function clamp01(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

type ApiAnalyzedGame = {
    provider: GameSource;
    externalId: string;
    url: string | null;
    playedAt: string;
    timeClass: string;
    rated: boolean | null;
    result: string | null;
    termination: string | null;
    whiteName: string;
    whiteRating: number | null;
    blackName: string;
    blackRating: number | null;
    pgn: string;
    sourceUsername: string;
    sourceAccountId: string | null;
    userSide: 'WHITE' | 'BLACK';
};

function isRecord(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === 'object';
}

export function formatAnalysisSaveError(
    status: number,
    payload: unknown
): string {
    if (
        isRecord(payload) &&
        typeof payload.error === 'string' &&
        payload.error.trim()
    ) {
        return payload.error.trim().slice(0, 300);
    }
    if (status === 503) {
        return 'Saving the analysis took too long. No changes were written. Retry the analysis.';
    }
    return "We couldn't save this analysis. No changes were written. Retry the analysis.";
}

function isApiAnalyzedGame(x: unknown): x is ApiAnalyzedGame {
    if (!isRecord(x)) return false;
    return (
        (x.provider === 'LICHESS' ||
            x.provider === 'CHESSCOM' ||
            x.provider === 'MANUAL_PGN' ||
            x.provider === 'BACKRANQ_COACH') &&
        typeof x.externalId === 'string' &&
        typeof x.playedAt === 'string' &&
        typeof x.timeClass === 'string' &&
        typeof x.whiteName === 'string' &&
        typeof x.blackName === 'string' &&
        typeof x.pgn === 'string' &&
        typeof x.sourceUsername === 'string' &&
        (x.userSide === 'WHITE' || x.userSide === 'BLACK')
    );
}

type AnalysisRunContext = {
    ownerId: string;
    generation: number;
    cancelled: boolean;
    queue: string[];
    scheduledGameIds: Set<string>;
    activeGameDbId: string | null;
    total: number;
    completed: number;
    label: string;
    percent: number;
    engine: StockfishClient | null;
    engineCleaned: boolean;
    analysisDefaultsOverride: AnalysisDefaults | null;
    activeAnalysisDefaults: AnalysisDefaults | null;
    activeExtractOptions: TrainingMomentExtractionOptions | null;
    activeAnalysisQuality: AnalysisQuality | null;
};

export function normalizeApiDbGameToNormalized(
    dbGame: ApiAnalyzedGame
): NormalizedGame {
    // `/api/games/[id]` returns JSON-serialized prisma rows, so dates are strings.
    const provider = gameSourceToUi(dbGame.provider);
    const timeClass = timeClassToUi(dbGame.timeClass as TimeClass);
    const playedAtIso = new Date(dbGame.playedAt).toISOString();
    return {
        id: `${provider}:${dbGame.externalId}`,
        provider,
        url: dbGame.url ?? undefined,
        playedAt: playedAtIso,
        timeClass,
        rated: typeof dbGame.rated === 'boolean' ? dbGame.rated : undefined,
        white: {
            name: dbGame.whiteName,
            rating:
                typeof dbGame.whiteRating === 'number'
                    ? dbGame.whiteRating
                    : undefined,
        },
        black: {
            name: dbGame.blackName,
            rating:
                typeof dbGame.blackRating === 'number'
                    ? dbGame.blackRating
                    : undefined,
        },
        result: dbGame.result ?? undefined,
        termination: dbGame.termination ?? undefined,
        pgn: dbGame.pgn,
        provenance: {
            username: dbGame.sourceUsername,
            accountId: dbGame.sourceAccountId ?? undefined,
            userSide: dbGame.userSide === 'WHITE' ? 'white' : 'black',
        },
    };
}

class BackgroundAnalysisManager {
    private listeners = new Set<Listener>();
    private tablebase: LichessTablebaseClient | null = null;
    private ownerId: string | null = null;
    private runGeneration = 0;
    private activeRun: AnalysisRunContext | null = null;
    private lastError: string | null = null;
    private pendingUnanalyzedCount: number | null = null;
    private lastCompletion: AnalysisCompletionSummary | null = null;

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        cb(this.snapshot());
        return () => {
            this.listeners.delete(cb);
        };
    }

    snapshot(): BackgroundAnalysisSnapshot {
        const run = this.activeRun;
        return {
            ownerId: this.ownerId,
            state: this.lastError ? 'error' : run ? 'running' : 'idle',
            percent: Math.max(0, Math.min(100, run?.percent ?? 0)),
            label: run?.label ?? '',
            totalGames: run?.total ?? 0,
            completedGames: run?.completed ?? 0,
            queuedGames: run?.queue.length ?? 0,
            pendingUnanalyzedCount: this.pendingUnanalyzedCount,
            lastError: this.lastError,
            lastCompletion: this.lastCompletion,
        };
    }

    private emit() {
        const s = this.snapshot();
        for (const cb of this.listeners) cb(s);
    }

    private async ensureEngine(run: AnalysisRunContext) {
        if (!run.engine) {
            const { StockfishClient } = await import(
                '@/lib/analysis/stockfishClient'
            );
            if (!this.isCurrentRun(run)) {
                throw new Error('Analysis session changed.');
            }
            run.engine = new StockfishClient();
        }
        return run.engine;
    }

    private async ensureTablebase() {
        if (!this.tablebase) {
            const { LichessTablebaseClient } = await import(
                '@/lib/analysis/tablebase'
            );
            this.tablebase = new LichessTablebaseClient();
        }
        return this.tablebase;
    }

    private cleanupRunEngine(run: AnalysisRunContext) {
        if (run.engineCleaned) return;
        run.engineCleaned = true;
        const engine = run.engine;
        run.engine = null;
        engine?.cancelAll?.();
        engine?.terminate?.();
    }

    private isCurrentRun(run: AnalysisRunContext) {
        return (
            this.activeRun === run &&
            this.ownerId === run.ownerId &&
            this.runGeneration === run.generation
        );
    }

    setOwner(ownerId: string | null) {
        if (this.ownerId === ownerId) return;
        this.runGeneration += 1;
        const oldRun = this.activeRun;
        if (oldRun) {
            oldRun.cancelled = true;
            oldRun.queue = [];
            oldRun.scheduledGameIds.clear();
            oldRun.activeGameDbId = null;
            this.cleanupRunEngine(oldRun);
        }
        this.activeRun = null;
        this.ownerId = ownerId;
        this.lastError = null;
        this.lastCompletion = null;
        this.pendingUnanalyzedCount = null;
        this.emit();
    }

    private assertOwner(ownerId: string) {
        if (!ownerId || this.ownerId !== ownerId) {
            throw new Error('Analysis session changed. Please start again.');
        }
    }

    cancel(ownerId: string) {
        this.assertOwner(ownerId);
        const run = this.activeRun;
        if (run) {
            run.cancelled = true;
            for (const gameDbId of run.queue) {
                run.scheduledGameIds.delete(gameDbId);
            }
            run.queue = [];
            run.scheduledGameIds.clear();
            run.activeGameDbId = null;
            this.cleanupRunEngine(run);
            this.runGeneration += 1;
            this.activeRun = null;
        } else {
            this.lastError = null;
        }
        this.emit();
    }

    clearCompletion(ownerId: string) {
        this.assertOwner(ownerId);
        this.lastCompletion = null;
        this.lastError = null;
        this.emit();
    }

    enqueueGameDbIds(ownerId: string, ids: string[]) {
        return this.enqueueGameDbIdsWithOptions(ownerId, ids);
    }

    enqueueGameDbIdsWithOptions(
        ownerId: string,
        ids: string[],
        opts?: { analysisDefaults?: AnalysisDefaults }
    ): { acceptedIds: string[]; skippedIds: string[] } {
        this.assertOwner(ownerId);
        const existingRun = this.activeRun;
        const requested = Array.from(new Set(ids.filter(Boolean)));
        const acceptedIds = requested.filter(
            (id) => !existingRun?.scheduledGameIds.has(id)
        );
        const skippedIds = requested.filter((id) =>
            existingRun?.scheduledGameIds.has(id)
        );
        if (acceptedIds.length === 0) {
            return { acceptedIds, skippedIds };
        }

        if (opts?.analysisDefaults && existingRun) {
            const runningDefaults =
                existingRun.activeAnalysisDefaults ??
                existingRun.analysisDefaultsOverride;
            if (
                !runningDefaults ||
                !sameAnalysisDefaults(runningDefaults, opts.analysisDefaults)
            ) {
                throw new Error(
                    'A browser analysis batch is already running with different settings. Wait for it to finish before starting this batch.'
                );
            }
        }

        let run = existingRun;
        if (!run) {
            const generation = ++this.runGeneration;
            run = {
                ownerId,
                generation,
                cancelled: false,
                queue: [],
                scheduledGameIds: new Set<string>(),
                activeGameDbId: null,
                total: 0,
                completed: 0,
                label: '',
                percent: 0,
                engine: null,
                engineCleaned: false,
                analysisDefaultsOverride: opts?.analysisDefaults ?? null,
                activeAnalysisDefaults: null,
                activeExtractOptions: null,
                activeAnalysisQuality: null,
            };
            this.activeRun = run;
            this.lastError = null;
            this.lastCompletion = null;
            clearLastAnalysisCompletion(ownerId);
            publishLibraryChanged(ownerId, { invalidateCompletion: true });
        }

        for (const id of acceptedIds) run.scheduledGameIds.add(id);
        run.queue.push(...acceptedIds);
        run.total += acceptedIds.length;
        if (!existingRun) void this.run(run);
        this.emit();
        return { acceptedIds, skippedIds };
    }

    async refreshPendingUnanalyzedCount(
        ownerId: string
    ): Promise<number | null> {
        this.assertOwner(ownerId);
        const generation = this.runGeneration;
        try {
            const res = await fetch(
                '/api/games?hasAnalysis=false&page=1&limit=1'
            );
            if (!res.ok) throw new Error('Failed to fetch pending count');
            const json = (await res.json()) as { total?: number };
            if (
                this.ownerId !== ownerId ||
                this.runGeneration !== generation
            ) {
                return null;
            }
            this.pendingUnanalyzedCount =
                typeof json.total === 'number' ? json.total : 0;
            this.emit();
            return this.pendingUnanalyzedCount;
        } catch {
            if (
                this.ownerId !== ownerId ||
                this.runGeneration !== generation
            ) {
                return null;
            }
            this.pendingUnanalyzedCount = null;
            this.emit();
            return null;
        }
    }

    setPendingUnanalyzedCount(ownerId: string, count: number) {
        this.assertOwner(ownerId);
        this.pendingUnanalyzedCount = Math.max(
            0,
            Number.isFinite(count) ? Math.trunc(count) : 0
        );
        this.emit();
    }

    async enqueuePendingUnanalyzed(
        ownerId: string,
        opts?: { limit?: number }
    ) {
        this.assertOwner(ownerId);
        const generation = this.runGeneration;
        const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 20)));
        const res = await fetch(
            `/api/games?hasAnalysis=false&page=1&limit=${limit}`
        );
        if (!res.ok) throw new Error('Failed to fetch unanalyzed games');
        const json = (await res.json()) as {
            games?: { id: string }[];
            total?: number;
        };
        if (
            this.ownerId !== ownerId ||
            this.runGeneration !== generation
        ) {
            throw new Error('Analysis session changed. Please start again.');
        }
        const ids = (json.games ?? []).map((g) => g.id).filter(Boolean);
        if (typeof json.total === 'number')
            this.pendingUnanalyzedCount = json.total;
        return this.enqueueGameDbIds(ownerId, ids).acceptedIds.length;
    }

    private async run(run: AnalysisRunContext) {
        let failed = 0;
        let trainingMomentsGenerated = 0;
        const errors: string[] = [];
        let pendingAtCompletion: number | null = null;
        let pendingCountRefreshed = false;

        try {
            // Resolve extraction options once for the whole run. Lazy-module
            // failure belongs to the same terminal lifecycle as engine or API
            // failure, otherwise the singleton can remain permanently busy.
            const {
                analysisDefaultsToExtractOptions,
                defaultPreferences,
                pickAnalysisDefaults,
            } = await import('@/lib/preferences');
            try {
                const prefs = await this.loadPreferences();
                if (!this.isCurrentRun(run)) return;
                const defaults =
                    run.analysisDefaultsOverride ??
                    pickAnalysisDefaults(prefs);
                run.activeExtractOptions = analysisDefaultsToExtractOptions(
                    defaults,
                    {
                        returnAnalysis: true,
                    }
                );
                run.activeAnalysisDefaults = defaults;
                run.activeAnalysisQuality = defaults.analysisQuality;
            } catch {
                if (!this.isCurrentRun(run)) return;
                const prefs = defaultPreferences();
                const defaults = pickAnalysisDefaults(prefs);
                run.activeExtractOptions = analysisDefaultsToExtractOptions(
                    defaults,
                    { returnAnalysis: true }
                );
                run.activeAnalysisDefaults = defaults;
                run.activeAnalysisQuality = prefs.analysisQuality;
            }
            run.analysisDefaultsOverride = null;

            do {
                while (
                    this.isCurrentRun(run) &&
                    !run.cancelled &&
                    run.queue.length > 0
                ) {
                    const gameDbId = run.queue.shift()!;
                    run.activeGameDbId = gameDbId;

                    const overallTotal = Math.max(1, run.total);
                    const baseProcessed = run.completed + failed;
                    run.label = `Analyzing ${baseProcessed + 1}/${overallTotal}`;
                    run.percent = (baseProcessed / overallTotal) * 100;
                    this.emit();

                    try {
                        try {
                            const result = await this.analyzeOneGame({
                                run,
                                gameDbId,
                                onLocalProgress: (localFrac, phase) => {
                                    if (!this.isCurrentRun(run)) return;
                                    const overallFrac =
                                        (baseProcessed + clamp01(localFrac)) /
                                        overallTotal;
                                    run.percent = overallFrac * 100;
                                    run.label = `Analyzing ${
                                        baseProcessed + 1
                                    }/${overallTotal}${phase ? ` • ${phase}` : ''}`;
                                    this.emit();
                                },
                            });
                            if (!this.isCurrentRun(run)) return;
                            trainingMomentsGenerated +=
                                result.trainingMomentsGenerated;
                            run.completed += 1;
                        } catch (error) {
                            if (!this.isCurrentRun(run)) return;
                            if (!run.cancelled) {
                                failed += 1;
                                errors.push(
                                    error instanceof Error
                                        ? error.message
                                        : 'Analysis failed'
                                );
                            }
                        }
                    } finally {
                        run.scheduledGameIds.delete(gameDbId);
                        if (run.activeGameDbId === gameDbId) {
                            run.activeGameDbId = null;
                        }
                    }
                    if (!this.isCurrentRun(run)) return;
                    if (run.cancelled) break;
                    run.label = `Processed ${run.completed + failed}/${Math.max(
                        1,
                        run.total
                    )} • ${run.completed} analyzed${
                        failed ? ` • ${failed} failed` : ''
                    }`;
                    run.percent =
                        ((run.completed + failed) / Math.max(1, run.total)) * 100;
                    this.emit();

                    // Small yield so navigation/UI stays snappy between games.
                    await new Promise((r) => setTimeout(r, 0));
                }
                if (!this.isCurrentRun(run)) return;
                if (run.cancelled) break;
                pendingCountRefreshed = true;
                pendingAtCompletion =
                    await this.refreshPendingUnanalyzedCount(run.ownerId);
                if (!this.isCurrentRun(run)) return;
            } while (run.queue.length > 0);
        } catch (error) {
            if (!this.isCurrentRun(run)) return;
            if (!run.cancelled) {
                failed += Math.max(0, run.total - run.completed - failed);
                errors.push(
                    error instanceof Error
                        ? error.message
                        : 'Analysis failed'
                );
            }
        } finally {
            this.cleanupRunEngine(run);
            if (!this.isCurrentRun(run)) return;
            if (!pendingCountRefreshed) {
                try {
                    pendingAtCompletion =
                        await this.refreshPendingUnanalyzedCount(run.ownerId);
                } catch {
                    pendingAtCompletion = null;
                }
            }
            if (!this.isCurrentRun(run)) return;
            const summary = createBrowserAnalysisCompletion({
                ownerId: run.ownerId,
                requested: run.total,
                succeeded: run.completed,
                failed,
                cancelled: run.cancelled,
                trainingMomentsGenerated,
                pendingAtCompletion,
                error: errors[0],
            });
            this.lastCompletion = summary;
            this.lastError =
                summary.status === 'failed' || summary.status === 'partial'
                    ? errors[0] ?? 'Analysis failed'
                    : null;

            publishAnalysisCompletion(summary);
            this.activeRun = null;
            run.queue = [];
            run.scheduledGameIds.clear();
            run.activeGameDbId = null;
            this.emit();
        }
    }

    private async analyzeOneGame(opts: {
        run: AnalysisRunContext;
        gameDbId: string;
        onLocalProgress?: (localFrac: number, phase?: string) => void;
    }): Promise<{ trainingMomentsGenerated: number }> {
        const res = await fetch(`/api/games/${opts.gameDbId}`);
        if (!this.isCurrentRun(opts.run)) {
            throw new Error('Analysis session changed.');
        }
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(
                `Failed to load game (${res.status}): ${txt.slice(0, 200)}`
            );
        }
        const json = (await res.json()) as unknown;
        const gameRaw = isRecord(json) ? json.game : null;
        if (!isApiAnalyzedGame(gameRaw))
            throw new Error('Missing/invalid game payload');

        const g = normalizeApiDbGameToNormalized(gameRaw);
        if (!g.pgn) throw new Error('Missing PGN for analysis');
        if (!resolveGameAnalysisProvenance(g)) {
            throw new Error('Game has invalid immutable analysis provenance');
        }

        const [engine, tablebase, extraction] = await Promise.all([
            this.ensureEngine(opts.run),
            this.ensureTablebase(),
            import('@/lib/analysis/extractTrainingMoments'),
        ]);
        if (!this.isCurrentRun(opts.run)) {
            throw new Error('Analysis session changed.');
        }
        const extractOptions = opts.run.activeExtractOptions;
        const analysisQuality = opts.run.activeAnalysisQuality;
        if (!extractOptions || !analysisQuality) {
            throw new Error('Analysis settings were not initialized.');
        }
        const out = await extraction.extractTrainingMomentsFromGames({
            games: [g],
            selectedGameIds: new Set([g.id]),
            engine,
            tablebase,
            canonicalSourceGameIdByGameId: {
                [g.id]: opts.gameDbId,
            },
            onProgress: (p) => {
                const local = p.plyCount > 0 ? (p.ply + 1) / p.plyCount : 0;
                opts.onLocalProgress?.(local, p.phase);
            },
            options: extractOptions,
        });
        if (!this.isCurrentRun(opts.run)) {
            throw new Error('Analysis session changed.');
        }

        const analysis = out.analysis?.get(g.id) as GameAnalysis | undefined;
        if (analysis) {
            const extractionManifest = out.manifests.find(
                (manifest) =>
                    manifest.sourceGameId === opts.gameDbId
            );
            if (!extractionManifest?.complete) {
                throw new Error('Training extraction did not complete');
            }
            const trainingMomentsForGame = out.moments.filter(
                (moment) => moment.sourceGameId === opts.gameDbId
            );
            const engineIdentity = await engine.getIdentity();
            if (!this.isCurrentRun(opts.run)) {
                throw new Error('Analysis session changed.');
            }
            const saveRes = await fetch(
                `/api/games/${opts.gameDbId}/analysis`,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        [EXPECTED_OWNER_HEADER]: opts.run.ownerId,
                    },
                    body: JSON.stringify({
                        analysis,
                        trainingMoments: trainingMomentsForGame,
                        extractionManifest,
                        configSnapshot: out.configSnapshot,
                        configHash: out.configHash,
                        analysisQuality,
                        engine: engineIdentity,
                    }),
                }
            );
            if (!this.isCurrentRun(opts.run)) {
                throw new Error('Analysis session changed.');
            }
            if (!saveRes.ok) {
                const payload = (await saveRes
                    .json()
                    .catch(() => null)) as unknown;
                throw new Error(
                    formatAnalysisSaveError(saveRes.status, payload)
                );
            }
            const savedJson = (await saveRes.json().catch(() => ({}))) as {
                ownerId?: string;
                trainingMoments?: { upserted?: number };
            };
            if (savedJson.ownerId !== opts.run.ownerId) {
                throw new Error(
                    'Analysis was saved for a different account.'
                );
            }
            return {
                trainingMomentsGenerated:
                    typeof savedJson.trainingMoments?.upserted === 'number'
                        ? savedJson.trainingMoments.upserted
                        : trainingMomentsForGame.length,
            };
        } else {
            throw new Error('Analysis produced no result');
        }
    }

    private async loadPreferences(): Promise<PreferencesSchema> {
        const res = await fetch('/api/user/preferences', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load preferences');
        const json = (await res.json().catch(() => ({}))) as {
            preferences?: PreferencesSchema;
            error?: string;
        };
        if (!json.preferences)
            throw new Error(json.error ?? 'Missing preferences');
        return json.preferences;
    }
}

function sameAnalysisDefaults(a: AnalysisDefaults, b: AnalysisDefaults) {
    return (
        a.analysisQuality === b.analysisQuality &&
        a.trainingCoveragePreset === b.trainingCoveragePreset &&
        a.trainingGradingTolerance === b.trainingGradingTolerance
    );
}

export const backgroundAnalysis = new BackgroundAnalysisManager();
