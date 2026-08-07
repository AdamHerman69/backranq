import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import {
    extractTrainingMomentsFromGames,
    type TrainingMomentExtractionOptions,
} from '@/lib/analysis/extractTrainingMoments';
import { gameSourceToUi, timeClassToUi } from '@/lib/api/games';
import type { GameSource, TimeClass } from '@prisma/client';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    pickAnalysisDefaults,
    type AnalysisDefaults,
    type PreferencesSchema,
} from '@/lib/preferences';
import type { AnalysisQuality } from '@/lib/analysis/quality';
import {
    clearLastAnalysisCompletion,
    createBrowserAnalysisCompletion,
    publishAnalysisCompletion,
    publishLibraryChanged,
    type AnalysisCompletionSummary,
} from '@/lib/analysis/analysisCompletion';

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
    private engine: StockfishClient | null = null;
    private readonly tablebase = new LichessTablebaseClient();
    private cancelled = false;
    private ownerId: string | null = null;
    private runGeneration = 0;

    private queue: string[] = []; // db game ids
    private running = false;

    private total = 0;
    private completed = 0;
    private label = '';
    private percent = 0;
    private lastError: string | null = null;
    private pendingUnanalyzedCount: number | null = null;
    private lastCompletion: AnalysisCompletionSummary | null = null;

    private nextRunAnalysisDefaultsOverride: AnalysisDefaults | null = null;
    private activeAnalysisDefaults: AnalysisDefaults | null = null;
    private activeExtractOptions: TrainingMomentExtractionOptions | null =
        null;
    private activeAnalysisQuality: AnalysisQuality | null = null;

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        cb(this.snapshot());
        return () => {
            this.listeners.delete(cb);
        };
    }

    snapshot(): BackgroundAnalysisSnapshot {
        return {
            ownerId: this.ownerId,
            state: this.lastError ? 'error' : this.running ? 'running' : 'idle',
            percent: Math.max(0, Math.min(100, this.percent)),
            label: this.label,
            totalGames: this.total,
            completedGames: this.completed,
            queuedGames: this.queue.length,
            pendingUnanalyzedCount: this.pendingUnanalyzedCount,
            lastError: this.lastError,
            lastCompletion: this.lastCompletion,
        };
    }

    private emit() {
        const s = this.snapshot();
        for (const cb of this.listeners) cb(s);
    }

    private ensureEngine() {
        if (!this.engine) this.engine = new StockfishClient();
        return this.engine;
    }

    setOwner(ownerId: string | null) {
        if (this.ownerId === ownerId) return;
        this.runGeneration += 1;
        this.cancelled = true;
        this.queue = [];
        this.engine?.cancelAll?.();
        this.engine = null;
        this.ownerId = ownerId;
        this.running = false;
        this.total = 0;
        this.completed = 0;
        this.percent = 0;
        this.label = '';
        this.lastError = null;
        this.lastCompletion = null;
        this.pendingUnanalyzedCount = null;
        this.nextRunAnalysisDefaultsOverride = null;
        this.activeAnalysisDefaults = null;
        this.activeExtractOptions = null;
        this.activeAnalysisQuality = null;
        this.emit();
    }

    private assertOwner(ownerId: string) {
        if (!ownerId || this.ownerId !== ownerId) {
            throw new Error('Analysis session changed. Please start again.');
        }
    }

    cancel(ownerId: string) {
        this.assertOwner(ownerId);
        this.cancelled = true;
        this.queue = [];
        this.engine?.cancelAll?.();
        if (!this.running) {
            this.total = 0;
            this.completed = 0;
            this.percent = 0;
            this.label = '';
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
        this.enqueueGameDbIdsWithOptions(ownerId, ids);
    }

    enqueueGameDbIdsWithOptions(
        ownerId: string,
        ids: string[],
        opts?: { analysisDefaults?: AnalysisDefaults }
    ) {
        this.assertOwner(ownerId);
        const unique = ids
            .filter(Boolean)
            .filter((id) => !this.queue.includes(id));
        if (unique.length === 0) return;

        if (opts?.analysisDefaults && this.running) {
            const runningDefaults =
                this.activeAnalysisDefaults ??
                this.nextRunAnalysisDefaultsOverride;
            if (
                !runningDefaults ||
                !sameAnalysisDefaults(runningDefaults, opts.analysisDefaults)
            ) {
                throw new Error(
                    'A browser analysis batch is already running with different settings. Wait for it to finish before starting this batch.'
                );
            }
        }

        // Only allow setting overrides when a run isn't already in progress; otherwise
        // we'd have a mid-queue option switch which is surprising.
        if (opts?.analysisDefaults && !this.running) {
            this.nextRunAnalysisDefaultsOverride = opts.analysisDefaults;
        }

        this.queue.push(...unique);
        this.total += unique.length;
        if (!this.running) void this.run(ownerId);
        this.emit();
    }

    async refreshPendingUnanalyzedCount(
        ownerId: string
    ): Promise<number | null> {
        this.assertOwner(ownerId);
        try {
            const res = await fetch(
                '/api/games?hasAnalysis=false&page=1&limit=1'
            );
            if (!res.ok) throw new Error('Failed to fetch pending count');
            const json = (await res.json()) as { total?: number };
            this.assertOwner(ownerId);
            this.pendingUnanalyzedCount =
                typeof json.total === 'number' ? json.total : 0;
            this.emit();
            return this.pendingUnanalyzedCount;
        } catch {
            if (this.ownerId !== ownerId) return null;
            this.pendingUnanalyzedCount = null;
            this.emit();
            return null;
        }
    }

    async enqueuePendingUnanalyzed(
        ownerId: string,
        opts?: { limit?: number }
    ) {
        this.assertOwner(ownerId);
        const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 20)));
        const res = await fetch(
            `/api/games?hasAnalysis=false&page=1&limit=${limit}`
        );
        if (!res.ok) throw new Error('Failed to fetch unanalyzed games');
        const json = (await res.json()) as {
            games?: { id: string }[];
            total?: number;
        };
        this.assertOwner(ownerId);
        const ids = (json.games ?? []).map((g) => g.id).filter(Boolean);
        if (typeof json.total === 'number')
            this.pendingUnanalyzedCount = json.total;
        this.enqueueGameDbIds(ownerId, ids);
        return ids.length;
    }

    private async run(ownerId: string) {
        this.assertOwner(ownerId);
        const generation = ++this.runGeneration;
        this.running = true;
        this.lastError = null;
        this.lastCompletion = null;
        clearLastAnalysisCompletion(ownerId);
        publishLibraryChanged(ownerId, { invalidateCompletion: true });
        this.cancelled = false;
        this.emit();

        // Resolve the extraction options once for the whole run, so settings are consistent.
        // Priority: caller-provided overrides (modal) → saved preferences → defaults.
        try {
            const prefs = await this.loadPreferences();
            const defaults =
                this.nextRunAnalysisDefaultsOverride ??
                pickAnalysisDefaults(prefs);
            this.activeExtractOptions = analysisDefaultsToExtractOptions(
                defaults,
                {
                    returnAnalysis: true,
                }
            );
            this.activeAnalysisDefaults = defaults;
            this.activeAnalysisQuality = defaults.analysisQuality;
        } catch {
            const prefs = defaultPreferences();
            const defaults = pickAnalysisDefaults(prefs);
            this.activeExtractOptions = analysisDefaultsToExtractOptions(
                defaults,
                { returnAnalysis: true }
            );
            this.activeAnalysisDefaults = defaults;
            this.activeAnalysisQuality = prefs.analysisQuality;
        } finally {
            this.nextRunAnalysisDefaultsOverride = null;
        }

        let failed = 0;
        let trainingMomentsGenerated = 0;
        const errors: string[] = [];

        try {
            while (!this.cancelled && this.queue.length > 0) {
                const gameDbId = this.queue.shift()!;

                const overallTotal = Math.max(1, this.total);
                const baseProcessed = this.completed + failed;
                this.label = `Analyzing ${baseProcessed + 1}/${overallTotal}`;
                this.percent = (baseProcessed / overallTotal) * 100;
                this.emit();

                try {
                    const result = await this.analyzeOneGame({
                        gameDbId,
                        onLocalProgress: (localFrac, phase) => {
                            const overallFrac =
                                (baseProcessed + clamp01(localFrac)) /
                                overallTotal;
                            this.percent = overallFrac * 100;
                            this.label = `Analyzing ${
                                baseProcessed + 1
                            }/${overallTotal}${phase ? ` • ${phase}` : ''}`;
                            this.emit();
                        },
                    });
                    trainingMomentsGenerated +=
                        result.trainingMomentsGenerated;
                    this.completed += 1;
                } catch (error) {
                    if (this.cancelled) break;
                    failed += 1;
                    errors.push(
                        error instanceof Error
                            ? error.message
                            : 'Analysis failed'
                    );
                }
                this.label = `Processed ${this.completed + failed}/${Math.max(
                    1,
                    this.total
                )} • ${this.completed} analyzed${
                    failed ? ` • ${failed} failed` : ''
                }`;
                this.percent =
                    ((this.completed + failed) / Math.max(1, this.total)) * 100;
                this.emit();

                // Small yield so navigation/UI stays snappy between games.
                await new Promise((r) => setTimeout(r, 0));
            }
        } finally {
            if (
                generation !== this.runGeneration ||
                this.ownerId !== ownerId
            ) {
                return;
            }
            const pendingAtCompletion =
                await this.refreshPendingUnanalyzedCount(ownerId);
            if (
                generation !== this.runGeneration ||
                this.ownerId !== ownerId
            ) {
                return;
            }
            const summary = createBrowserAnalysisCompletion({
                ownerId,
                requested: this.total,
                succeeded: this.completed,
                failed,
                cancelled: this.cancelled,
                trainingMomentsGenerated,
                pendingAtCompletion,
                error: errors[0],
            });
            this.lastCompletion = summary;
            this.lastError =
                summary.status === 'failed' || summary.status === 'partial'
                    ? errors[0] ?? 'Analysis failed'
                    : null;

            this.running = false;
            this.queue = [];
            this.total = 0;
            this.completed = 0;
            this.percent = 0;
            this.label = '';
            this.activeAnalysisDefaults = null;
            this.activeExtractOptions = null;
            this.activeAnalysisQuality = null;
            this.emit();
            publishAnalysisCompletion(summary);
        }
    }

    private async analyzeOneGame(opts: {
        gameDbId: string;
        onLocalProgress?: (localFrac: number, phase?: string) => void;
    }): Promise<{ trainingMomentsGenerated: number }> {
        const res = await fetch(`/api/games/${opts.gameDbId}`);
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

        const engine = this.ensureEngine();
        const fallbackDefaults = pickAnalysisDefaults(defaultPreferences());
        const extractOptions =
            this.activeExtractOptions ??
            analysisDefaultsToExtractOptions(fallbackDefaults, {
                returnAnalysis: true,
            });
        const analysisQuality =
            this.activeAnalysisQuality ?? fallbackDefaults.analysisQuality;
        const out = await extractTrainingMomentsFromGames({
            games: [g],
            selectedGameIds: new Set([g.id]),
            engine,
            tablebase: this.tablebase,
            canonicalSourceGameIdByGameId: {
                [g.id]: opts.gameDbId,
            },
            onProgress: (p) => {
                const local = p.plyCount > 0 ? (p.ply + 1) / p.plyCount : 0;
                opts.onLocalProgress?.(local, p.phase);
            },
            options: extractOptions,
        });

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
            const saveRes = await fetch(
                `/api/games/${opts.gameDbId}/analysis`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
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
            if (!saveRes.ok) {
                const payload = (await saveRes
                    .json()
                    .catch(() => null)) as unknown;
                throw new Error(
                    formatAnalysisSaveError(saveRes.status, payload)
                );
            }
            const savedJson = (await saveRes.json().catch(() => ({}))) as {
                trainingMoments?: { upserted?: number };
            };
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
