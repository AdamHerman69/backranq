'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    defaultPreferences,
    type PreferencesSchema,
} from '@/lib/preferences';

export function TrainerSettingsCard() {
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [contextHintsEnabled, setContextHintsEnabled] = React.useState(
        defaultPreferences().trainerContextHintsEnabled
    );

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const response = await fetch('/api/user/preferences', {
                    cache: 'no-store',
                });
                const body = (await response.json().catch(() => ({}))) as {
                    preferences?: PreferencesSchema;
                    error?: string;
                };
                if (!response.ok) {
                    throw new Error(body.error ?? 'Failed to load preferences');
                }
                if (!cancelled && body.preferences) {
                    setContextHintsEnabled(
                        body.preferences.trainerContextHintsEnabled === true
                    );
                }
            } catch {
                // Keep spoiler-free defaults when preferences are unavailable.
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void load();
        return () => {
            cancelled = true;
        };
    }, []);

    async function save() {
        setBusy(true);
        const toastId = toast.loading('Saving trainer settings…');
        try {
            const response = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trainerContextHintsEnabled: contextHintsEnabled,
                }),
            });
            const body = (await response.json().catch(() => ({}))) as {
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok) throw new Error(body.error ?? 'Save failed');
            if (body.preferences) {
                setContextHintsEnabled(
                    body.preferences.trainerContextHintsEnabled === true
                );
            }
            toast.success('Trainer settings saved.', { id: toastId });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Save failed', {
                id: toastId,
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Puzzle trainer</CardTitle>
                <CardDescription>
                    New puzzles are spoiler-free by default. Context hints can reveal
                    the puzzle category or motif before your first move.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                    <div>
                        <label
                            htmlFor="trainer-context-hints"
                            className="text-sm font-medium"
                        >
                            Show context hints before solving
                        </label>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Off is recommended: you decide whether the position needs a
                            quiet move or a finishing blow.
                        </p>
                    </div>
                    <input
                        id="trainer-context-hints"
                        type="checkbox"
                        checked={contextHintsEnabled}
                        onChange={(event) =>
                            setContextHintsEnabled(event.target.checked)
                        }
                        disabled={loading || busy}
                        className="mt-1 h-5 w-5 accent-primary"
                        aria-label="Show puzzle context hints before solving"
                    />
                </div>
                <Button type="button" onClick={save} disabled={loading || busy}>
                    Save
                </Button>
            </CardContent>
        </Card>
    );
}
