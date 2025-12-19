import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import {
    extractPuzzlesFromGames,
    type ExtractOptions,
} from '@/lib/analysis/extractPuzzles';
import { getSyncStatus } from '@/lib/services/gameSync';
import { timeClassToUi } from '@/lib/api/games';
import type { TimeClass } from '@prisma/client';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    pickAnalysisDefaults,
    type AnalysisDefaults,
    type PreferencesSchema,
} from '@/lib/preferences';

export type BackgroundAnalysisSnapshot = {
    state: 'idle' | 'running' | 'error';
    percent: number; // 0..100
    label: string;
    totalGames: number;
    completedGames: number;
    queuedGames: number;
    pendingUnanalyzedCount: number | null;
    lastError: string | null;
};

type Listener = (s: BackgroundAnalysisSnapshot) => void;

function clamp01(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

type ApiAnalyzedGame = {
    provider: 'LICHESS' | 'CHESSCOM';
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
};

function isRecord(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === 'object';
}

function isApiAnalyzedGame(x: unknown): x is ApiAnalyzedGame {
    if (!isRecord(x)) return false;
    return (
        (x.provider === 'LICHESS' || x.provider === 'CHESSCOM') &&
        typeof x.externalId === 'string' &&
        typeof x.playedAt === 'string' &&
        typeof x.timeClass === 'string' &&
        typeof x.whiteName === 'string' &&
        typeof x.blackName === 'string' &&
        typeof x.pgn === 'string'
    );
}

function normalizeApiDbGameToNormalized(
    dbGame: ApiAnalyzedGame
): NormalizedGame {
    // `/api/games/[id]` returns JSON-serialized prisma rows, so dates are strings.
    const provider = dbGame.provider === 'LICHESS' ? 'lichess' : 'chesscom';
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
    };
}

class BackgroundAnalysisManager {
    private listeners = new Set<Listener>();
    private engine: StockfishClient | null = null;
    private cancelled = false;

    private queue: string[] = []; // db game ids
    private running = false;

    private total = 0;
    private completed = 0;
    private label = '';
    private percent = 0;
    private lastError: string | null = null;
    private pendingUnanalyzedCount: number | null = null;

    private nextRunAnalysisDefaultsOverride: AnalysisDefaults | null = null;
    private activeExtractOptions: ExtractOptions | null = null;

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        cb(this.snapshot());
        return () => {
            this.listeners.delete(cb);
        };
    }

    snapshot(): BackgroundAnalysisSnapshot {
        return {
            state: this.lastError ? 'error' : this.running ? 'running' : 'idle',
            percent: Math.max(0, Math.min(100, this.percent)),
            label: this.label,
            totalGames: this.total,
            completedGames: this.completed,
            queuedGames: this.queue.length,
            pendingUnanalyzedCount: this.pendingUnanalyzedCount,
            lastError: this.lastError,
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

    cancel() {
        this.cancelled = true;
        this.queue = [];
        this.total = 0;
        this.completed = 0;
        this.percent = 0;
        this.label = '';
        this.lastError = null;
        this.engine?.cancelAll?.();
        this.emit();
    }

    enqueueGameDbIds(ids: string[]) {
        this.enqueueGameDbIdsWithOptions(ids);
    }

    enqueueGameDbIdsWithOptions(
        ids: string[],
        opts?: { analysisDefaults?: AnalysisDefaults }
    ) {
        const unique = ids
            .filter(Boolean)
            .filter((id) => !this.queue.includes(id));
        if (unique.length === 0) return;

        // Only allow setting overrides when a run isn't already in progress; otherwise
        // we'd have a mid-queue option switch which is surprising.
        if (opts?.analysisDefaults && !this.running) {
            this.nextRunAnalysisDefaultsOverride = opts.analysisDefaults;
        }

        this.queue.push(...unique);
        this.total += unique.length;
        if (!this.running) void this.run();
        this.emit();
    }

    async refreshPendingUnanalyzedCount(): Promise<number | null> {
        try {
            const res = await fetch(
                '/api/games?hasAnalysis=false&page=1&limit=1'
            );
            if (!res.ok) throw new Error('Failed to fetch pending count');
            const json = (await res.json()) as { total?: number };
            this.pendingUnanalyzedCount =
                typeof json.total === 'number' ? json.total : 0;
            this.emit();
            return this.pendingUnanalyzedCount;
        } catch {
            this.pendingUnanalyzedCount = null;
            this.emit();
            return null;
        }
    }

    async enqueuePendingUnanalyzed(opts?: { limit?: number }) {
        const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 20)));
        const res = await fetch(
            `/api/games?hasAnalysis=false&page=1&limit=${limit}`
        );
        if (!res.ok) throw new Error('Failed to fetch unanalyzed games');
        const json = (await res.json()) as {
            games?: { id: string }[];
            total?: number;
        };
        const ids = (json.games ?? []).map((g) => g.id).filter(Boolean);
        if (typeof json.total === 'number')
            this.pendingUnanalyzedCount = json.total;
        this.enqueueGameDbIds(ids);
    }

    private async run() {
        this.running = true;
        this.lastError = null;
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
        } catch {
            const prefs = defaultPreferences();
            this.activeExtractOptions = analysisDefaultsToExtractOptions(
                pickAnalysisDefaults(prefs),
                { returnAnalysis: true }
            );
        } finally {
            this.nextRunAnalysisDefaultsOverride = null;
        }

        let sync: Awaited<ReturnType<typeof getSyncStatus>> | null = null;
        try {
            sync = await getSyncStatus();
        } catch {
            // continue; username hints are optional.
            sync = null;
        }

        try {
            while (!this.cancelled && this.queue.length > 0) {
                const gameDbId = this.queue.shift()!;

                const overallTotal = Math.max(1, this.total);
                const baseDone = this.completed;
                this.label = `Analyzing ${baseDone + 1}/${overallTotal}`;
                this.percent = (baseDone / overallTotal) * 100;
                this.emit();

                await this.analyzeOneGame({
                    gameDbId,
                    usernameByProvider: {
                        lichess: sync?.linked.lichessUsername ?? undefined,
                        chesscom: sync?.linked.chesscomUsername ?? undefined,
                    },
                    onLocalProgress: (localFrac, phase) => {
                        const overallFrac =
                            (baseDone + clamp01(localFrac)) / overallTotal;
                        this.percent = overallFrac * 100;
                        this.label = `Analyzing ${
                            baseDone + 1
                        }/${overallTotal}${phase ? ` • ${phase}` : ''}`;
                        this.emit();
                    },
                });

                this.completed += 1;
                this.label = `Analyzed ${this.completed}/${Math.max(
                    1,
                    this.total
                )}`;
                this.percent = (this.completed / Math.max(1, this.total)) * 100;
                this.emit();

                // Small yield so navigation/UI stays snappy between games.
                await new Promise((r) => setTimeout(r, 0));
            }
        } catch (e) {
            this.lastError = e instanceof Error ? e.message : 'Analysis failed';
            this.emit();
        } finally {
            // Reset job totals when queue drains (but keep pending count)
            this.running = false;
            this.queue = [];
            this.total = 0;
            this.completed = 0;
            this.percent = 0;
            this.label = '';
            this.emit();
            void this.refreshPendingUnanalyzedCount();
        }
    }

    private async analyzeOneGame(opts: {
        gameDbId: string;
        usernameByProvider: { lichess?: string; chesscom?: string };
        onLocalProgress?: (localFrac: number, phase?: string) => void;
    }) {
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

        const engine = this.ensureEngine();
        const extractOptions = this.activeExtractOptions ?? {
            movetimeMs: 200,
            returnAnalysis: true,
            maxPuzzlesPerGame: null,
            puzzleMode: 'both',
        };
        const out = await extractPuzzlesFromGames({
            games: [g],
            selectedGameIds: new Set([g.id]),
            engine,
            usernameByProvider: opts.usernameByProvider,
            onProgress: (p) => {
                const local = p.plyCount > 0 ? (p.ply + 1) / p.plyCount : 0;
                opts.onLocalProgress?.(local, p.phase);
            },
            options: extractOptions,
        });

        const analysis = out.analysis?.get(g.id) as GameAnalysis | undefined;
        if (analysis) {
            const saveRes = await fetch(
                `/api/games/${opts.gameDbId}/analysis`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(analysis),
                }
            );
            if (!saveRes.ok) {
                const txt = await saveRes.text().catch(() => '');
                throw new Error(
                    `Failed to save analysis (${saveRes.status}): ${txt.slice(
                        0,
                        200
                    )}`
                );
            }
        }

        const puzzlesForGame = (out.puzzles ?? []).filter(
            (p) => p.sourceGameId === g.id
        );
        const puzzlesRes = await fetch(`/api/games/${opts.gameDbId}/puzzles`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ puzzles: puzzlesForGame }),
        });
        if (!puzzlesRes.ok) {
            const txt = await puzzlesRes.text().catch(() => '');
            throw new Error(
                `Failed to save puzzles (${puzzlesRes.status}): ${txt.slice(
                    0,
                    200
                )}`
            );
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

export const backgroundAnalysis = new BackgroundAnalysisManager();
