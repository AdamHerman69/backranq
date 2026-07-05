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
        autoAnalyzeEnabled: true,
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
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
        } finally {
            setSaving(false);
        }
    }

    function toggle<K extends keyof AutoPrefs>(key: K, value: AutoPrefs[K]) {
        void save({ ...prefs, [key]: value });
    }

    function toggleProvider(provider: 'lichess' | 'chesscom', value: boolean) {
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
                <CardTitle className="text-base">Automatic sync</CardTitle>
                <CardDescription>
                    Backranq checks linked accounts once per day and queues new games for server analysis.
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
                        <span className="block font-medium">Auto-analyze imports</span>
                        <span className="text-muted-foreground">Create server analysis jobs for newly imported games.</span>
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
            </CardContent>
        </Card>
    );
}
