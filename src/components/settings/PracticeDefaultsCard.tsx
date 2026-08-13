'use client';

import * as React from 'react';
import { Target } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from 'next-auth/react';

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
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunGenerationCurrent,
    resolveSessionOwnerId,
    type OwnerEpoch,
} from '@/lib/auth/ownerRun';

export function canSavePracticeMix({
    busy,
    loadError,
    loading,
    mix,
    ownerReady,
    savedMix,
}: {
    busy: boolean;
    loadError: string | null;
    loading: boolean;
    mix: TrainingSessionMix;
    ownerReady: boolean;
    savedMix: TrainingSessionMix | null;
}) {
    return (
        ownerReady &&
        !busy &&
        !loading &&
        loadError === null &&
        savedMix !== null &&
        mix !== savedMix
    );
}

export function PracticeDefaultsCard({
    ownerId: initialOwnerId,
}: {
    ownerId: string;
}) {
    const { data: session, status: sessionStatus } = useSession();
    const activeOwnerId = resolveSessionOwnerId({
        sessionStatus,
        liveOwnerId: session?.user?.id ?? null,
        initialOwnerId,
    });
    const ownerEpochRef = React.useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        activeOwnerId
    );
    const loadControllerRef = React.useRef<AbortController | null>(null);
    const mutationControllerRef = React.useRef<AbortController | null>(null);
    const loadGenerationRef = React.useRef(0);
    const mutationGenerationRef = React.useRef(0);
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [mix, setMix] = React.useState<TrainingSessionMix>(
        defaultPreferences().trainingSessionMix
    );
    const [savedMix, setSavedMix] =
        React.useState<TrainingSessionMix | null>(null);
    const [loadedOwnerId, setLoadedOwnerId] = React.useState<string | null>(
        null
    );

    const load = React.useCallback(async () => {
        const run = captureOwnerRun(ownerEpochRef.current);
        const generation = loadGenerationRef.current + 1;
        loadGenerationRef.current = generation;
        loadControllerRef.current?.abort();
        mutationGenerationRef.current += 1;
        mutationControllerRef.current?.abort();
        mutationControllerRef.current = null;
        setLoadedOwnerId(null);
        setSavedMix(null);
        setLoading(true);
        setBusy(false);
        setLoadError(null);
        if (!run || run.ownerId !== initialOwnerId) {
            setLoadError(
                'Your signed-in account changed. Reload Settings to continue.'
            );
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        loadControllerRef.current = controller;
        const isCurrent = () =>
            !controller.signal.aborted &&
            isOwnerRunGenerationCurrent({
                run,
                epoch: ownerEpochRef.current,
                generation,
                currentGeneration: loadGenerationRef.current,
            });
        try {
            const response = await fetch('/api/user/preferences', {
                cache: 'no-store',
                signal: controller.signal,
            });
            const body = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok || !body.preferences) {
                throw new Error(
                    body.error ?? 'Failed to load practice settings'
                );
            }
            if (!isCurrent()) return;
            if (body.ownerId !== run.ownerId) {
                throw new Error(
                    'The server returned practice settings for a different account.'
                );
            }

            const loadedMix = body.preferences.trainingSessionMix;
            setMix(loadedMix);
            setSavedMix(loadedMix);
            setLoadedOwnerId(run.ownerId);
        } catch (error) {
            if (!isCurrent()) return;
            setSavedMix(null);
            setLoadError(
                error instanceof Error
                    ? error.message
                    : 'Failed to load practice settings'
            );
        } finally {
            if (loadControllerRef.current === controller) {
                loadControllerRef.current = null;
            }
            if (isCurrent()) setLoading(false);
        }
    }, [initialOwnerId]);

    React.useEffect(() => {
        void load();
        return () => {
            loadGenerationRef.current += 1;
            mutationGenerationRef.current += 1;
            loadControllerRef.current?.abort();
            mutationControllerRef.current?.abort();
        };
    }, [activeOwnerId, load]);

    const ownerReady =
        activeOwnerId === initialOwnerId && loadedOwnerId === initialOwnerId;

    const canSave = canSavePracticeMix({
        busy,
        loadError,
        loading,
        mix,
        ownerReady,
        savedMix,
    });

    async function save() {
        if (!canSave) return;
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || run.ownerId !== loadedOwnerId) return;
        mutationControllerRef.current?.abort();
        const controller = new AbortController();
        mutationControllerRef.current = controller;
        const generation = mutationGenerationRef.current + 1;
        mutationGenerationRef.current = generation;
        const isCurrent = () =>
            !controller.signal.aborted &&
            loadedOwnerId === run.ownerId &&
            isOwnerRunGenerationCurrent({
                run,
                epoch: ownerEpochRef.current,
                generation,
                currentGeneration: mutationGenerationRef.current,
            });

        const toastId = toast.loading('Saving position mix…');
        setBusy(true);
        try {
            const response = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: run.ownerId,
                },
                body: JSON.stringify({ trainingSessionMix: mix }),
                signal: controller.signal,
            });
            const body = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!isCurrent()) return;
            if (!response.ok) {
                throw new Error(body.error ?? 'Save failed');
            }
            if (body.ownerId !== run.ownerId || !body.preferences) {
                throw new Error(
                    'The server saved practice settings for a different account.'
                );
            }
            const persistedMix = body.preferences?.trainingSessionMix ?? mix;
            setMix(persistedMix);
            setSavedMix(persistedMix);
            toast.success('Default position mix saved.', { id: toastId });
        } catch (error) {
            if (
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError') ||
                !isCurrent()
            ) {
                toast.dismiss(toastId);
                return;
            }
            toast.error(
                error instanceof Error ? error.message : 'Save failed',
                { id: toastId }
            );
        } finally {
            if (!isCurrent()) toast.dismiss(toastId);
            if (mutationControllerRef.current === controller) {
                mutationControllerRef.current = null;
            }
            if (isCurrent()) setBusy(false);
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
                        disabled={
                            loading || busy || loadError !== null || !ownerReady
                        }
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
