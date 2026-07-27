'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getSyncStatus, type SyncStatus } from '@/lib/services/gameSync';

type AutoPrefs = {
    autoSyncEnabled: boolean;
    autoAnalyzeEnabled: boolean;
    autoSyncProviders: { lichess: boolean; chesscom: boolean };
};

export function AutoSyncSettingsCard() {
    const [status, setStatus] = React.useState<SyncStatus | null>(null);
    const [prefs, setPrefs] = React.useState<AutoPrefs>({
        autoSyncEnabled: true,
        autoAnalyzeEnabled: false,
        autoSyncProviders: { lichess: true, chesscom: true },
    });
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        void load();
    }, []);

    async function load() {
        const next = await getSyncStatus();
        setStatus(next);
        if (next.autoSync) {
            setPrefs({
                autoSyncEnabled: next.autoSync.enabled,
                autoAnalyzeEnabled: next.autoSync.autoAnalyzeEnabled,
                autoSyncProviders: next.autoSync.providers,
            });
        }
    }

    async function save(next: AutoPrefs) {
        const previous = prefs;
        setPrefs(next);
        setSaving(true);
        const id = toast.loading('Saving auto-sync settings…');
        try {
            const res = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(next),
            });
            const json = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(json.error ?? 'Save failed');
            toast.success('Auto-sync settings saved.', { id });
            await load();
        } catch (e) {
            setPrefs(previous);
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
        } finally {
            setSaving(false);
        }
    }

    function toggle<K extends keyof AutoPrefs>(key: K, value: AutoPrefs[K]) {
        if (saving) {
            toast.message('Saving settings…');
            return;
        }
        if (key === 'autoAnalyzeEnabled' && value === true && !prefs.autoAnalyzeEnabled) {
            const ok = window.confirm(
                'Automatically queue server analysis for newly imported games? This spends server credits within your daily/monthly caps.'
            );
            if (!ok) return;
        }
        void save({ ...prefs, [key]: value });
    }

    function toggleProvider(provider: 'lichess' | 'chesscom', value: boolean) {
        if (saving) {
            toast.message('Saving settings…');
            return;
        }
        void save({
            ...prefs,
            autoSyncProviders: {
                ...prefs.autoSyncProviders,
                [provider]: value,
            },
        });
    }

    const states = status?.autoSync?.states;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Automatic game sync</CardTitle>
                <CardDescription>
                    Backranq can import new games once per day. Importing is free; automatic server analysis spends credits only when enabled.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
                    <span>
                        <span className="block font-medium">Auto-sync games</span>
                        <span className="text-muted-foreground">Import new games from linked providers.</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={prefs.autoSyncEnabled}
                        disabled={saving}
                        onChange={(e) => toggle('autoSyncEnabled', e.target.checked)}
                    />
                </label>

                <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
                    <span>
                        <span className="block font-medium">Automatically spend server credits on matching games</span>
                        <span className="text-muted-foreground">Queue server analysis for newly imported games. Browser analysis is free but cannot run while this tab is closed.</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={prefs.autoAnalyzeEnabled}
                        disabled={saving || !prefs.autoSyncEnabled}
                        onChange={(e) => toggle('autoAnalyzeEnabled', e.target.checked)}
                    />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                    {(['lichess', 'chesscom'] as const).map((provider) => {
                        const label = provider === 'lichess' ? 'Lichess' : 'Chess.com';
                        const state = states?.[provider];
                        return (
                            <label key={provider} className="rounded-md border p-3 text-sm">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="font-medium">{label}</span>
                                    <input
                                        type="checkbox"
                                        checked={prefs.autoSyncProviders[provider]}
                                        disabled={saving || !prefs.autoSyncEnabled}
                                        onChange={(e) => toggleProvider(provider, e.target.checked)}
                                    />
                                </div>
                                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                                    <div>
                                        Last success:{' '}
                                        {state?.lastSuccessAt
                                            ? new Date(state.lastSuccessAt).toLocaleString()
                                            : '—'}
                                    </div>
                                    <div>
                                        Last checked:{' '}
                                        {state?.lastAttemptAt
                                            ? new Date(state.lastAttemptAt).toLocaleString()
                                            : '—'}
                                    </div>
                                    {state?.lastError ? (
                                        <div className="text-destructive">{state.lastError}</div>
                                    ) : null}
                                </div>
                            </label>
                        );
                    })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                    <div>
                        Server queue: {status?.analysisJobs?.running ?? 0} running,{' '}
                        {status?.analysisJobs?.queued ?? 0} queued,{' '}
                        {status?.analysisJobs?.failed ?? 0} failed
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                        Refresh
                    </Button>
                </div>

                <div className="rounded-md border p-3 text-sm">
                    <div className="font-medium">Server analysis rules</div>
                    <div className="mt-1 text-muted-foreground">
                        Safe defaults: losses and draws, rapid/classical, max 10 games per day,
                        max 50 credits per month, Balanced profile, stop below 10 credits.
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
