'use client';

import * as React from 'react';
import { Target } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { InlineStatus } from '@/components/ui/async-state';
import { LoadingButton } from '@/components/ui/loading-button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    defaultPreferences,
    type PreferencesSchema,
    type TrainingSessionMix,
} from '@/lib/preferences';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

export function canSavePracticeMix({
    busy,
    loadError,
    loading,
    mix,
    savedMix,
}: {
    busy: boolean;
    loadError: string | null;
    loading: boolean;
    mix: TrainingSessionMix;
    savedMix: TrainingSessionMix | null;
}) {
    return (
        !busy &&
        !loading &&
        loadError === null &&
        savedMix !== null &&
        mix !== savedMix
    );
}

export function PracticeDefaultsCard({ ownerId }: { ownerId: string }) {
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [mix, setMix] = React.useState<TrainingSessionMix>(
        defaultPreferences().trainingSessionMix
    );
    const [savedMix, setSavedMix] =
        React.useState<TrainingSessionMix | null>(null);
    const requestIdRef = React.useRef(0);

    const load = React.useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setLoadError(null);
        try {
            const response = await fetch('/api/user/preferences', {
                cache: 'no-store',
            });
            const body = (await response.json().catch(() => ({}))) as {
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok || !body.preferences) {
                throw new Error(
                    body.error ?? 'Failed to load practice settings'
                );
            }
            if (requestId !== requestIdRef.current) return;

            const loadedMix = body.preferences.trainingSessionMix;
            setMix(loadedMix);
            setSavedMix(loadedMix);
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            setSavedMix(null);
            setLoadError(
                error instanceof Error
                    ? error.message
                    : 'Failed to load practice settings'
            );
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        void load();
        return () => {
            requestIdRef.current += 1;
        };
    }, [load]);

    const canSave = canSavePracticeMix({
        busy,
        loadError,
        loading,
        mix,
        savedMix,
    });

    async function save() {
        if (!canSave) return;

        const toastId = toast.loading('Saving position mix…');
        setBusy(true);
        try {
            const response = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: ownerId,
                },
                body: JSON.stringify({ trainingSessionMix: mix }),
            });
            const body = (await response.json().catch(() => ({}))) as {
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok) {
                throw new Error(body.error ?? 'Save failed');
            }
            const persistedMix = body.preferences?.trainingSessionMix ?? mix;
            setMix(persistedMix);
            setSavedMix(persistedMix);
            toast.success('Default position mix saved.', { id: toastId });
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : 'Save failed',
                { id: toastId }
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card id="practice-defaults" variant="panel" className="scroll-mt-24 overflow-hidden">
            <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                <CardTitle className="flex items-center gap-2 text-base">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Target className="h-4 w-4" aria-hidden="true" />
                    </span>
                    Practice focus
                </CardTitle>
                <CardDescription>
                    Choose which personal decisions appear first when you open
                    Practice. You can still change focus for one session.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
                <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                        Default session mix
                    </span>
                    <Select
                        value={mix}
                        onValueChange={(value) =>
                            setMix(value as TrainingSessionMix)
                        }
                        disabled={loading || busy || loadError !== null}
                    >
                        <SelectTrigger aria-label="Default position mix">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ALL">
                                All personal decisions
                            </SelectItem>
                            <SelectItem value="MY_MISTAKES">
                                My mistakes
                            </SelectItem>
                            <SelectItem value="MISSED_OPPORTUNITIES">
                                Missed opportunities
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </label>
                {loading ? (
                    <InlineStatus tone="info" live>
                        Loading your current position mix…
                    </InlineStatus>
                ) : null}
                {loadError ? (
                    <InlineStatus tone="danger">
                        <div>
                            <p>
                            We could not load your current default. Nothing can
                            be saved until it is loaded.
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {loadError}
                            </p>
                            <Button
                                className="mt-3"
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void load()}
                                disabled={loading || busy}
                            >
                                Retry
                            </Button>
                        </div>
                    </InlineStatus>
                ) : null}
                <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-4">
                    <p
                        className="text-xs text-muted-foreground"
                        role="status"
                    >
                        {!loading && !loadError && savedMix !== null && mix === savedMix
                            ? 'Saved'
                            : 'Changes apply to your next session.'}
                    </p>
                    <LoadingButton
                        type="button"
                        loading={busy}
                        loadingLabel="Saving…"
                        onClick={save}
                        disabled={!canSave}
                    >
                        Save default
                    </LoadingButton>
                </div>
            </CardContent>
        </Card>
    );
}
