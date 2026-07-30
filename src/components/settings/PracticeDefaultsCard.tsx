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
        <Card>
            <CardHeader>
                <CardTitle className="text-base">
                    Default position mix
                </CardTitle>
                <CardDescription>
                    Used when you open Practice. You can temporarily override
                    it in Position focus. This only changes which positions
                    are selected; it never deletes saved positions.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
                {loading ? (
                    <p className="text-sm text-muted-foreground" role="status">
                        Loading your current position mix…
                    </p>
                ) : null}
                {loadError ? (
                    <div
                        className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
                        role="alert"
                    >
                        <p className="text-sm text-destructive">
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
                ) : null}
                <div className="flex items-center gap-3">
                    <Button
                        type="button"
                        onClick={save}
                        disabled={!canSave}
                    >
                        Save default
                    </Button>
                    {!loading &&
                    !loadError &&
                    savedMix !== null &&
                    mix === savedMix ? (
                        <p
                            className="text-xs text-muted-foreground"
                            role="status"
                        >
                            Saved
                        </p>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}
