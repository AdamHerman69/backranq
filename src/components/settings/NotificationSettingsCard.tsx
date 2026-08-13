'use client';

import * as React from 'react';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from 'next-auth/react';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';
import { ErrorState, InlineStatus } from '@/components/ui/async-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ListSkeleton } from '@/components/ui/loading-patterns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type NotificationSettingsPreferences = {
    emailPracticeReady: boolean;
    emailAnalysisFailed: boolean;
    emailSyncSummary: boolean;
    emailBilling: boolean;
    emailWeeklyProgress: boolean;
    emailProductNews: boolean;
    pushEnabled: boolean;
    syncDigestFrequency: 'OFF' | 'DAILY' | 'WEEKLY';
    timezone: string;
    digestHour: number;
    emailSuppressedAt: string | null;
};
type Preferences = NotificationSettingsPreferences;

const EMAIL_OPTIONS: Array<{ key: keyof Preferences; label: string; description: string }> = [
    { key: 'emailPracticeReady', label: 'New practice ready', description: 'One quiet daily email at most, combining everything that became ready.' },
    { key: 'emailAnalysisFailed', label: 'Analysis and sync failures', description: 'Off by default; failures always remain visible in the app.' },
    { key: 'emailBilling', label: 'Billing and paused analysis', description: 'Important payment issues or automation stopped at your credit reserve.' },
    { key: 'emailWeeklyProgress', label: 'Weekly progress', description: 'A weekly recap of your practice activity.' },
    { key: 'emailProductNews', label: 'Product news', description: 'Optional Backranq features and announcements.' },
];

export function resolveNotificationSettingsOwnerId({
    sessionStatus,
    liveOwnerId,
    initialOwnerId,
}: {
    sessionStatus: 'loading' | 'authenticated' | 'unauthenticated';
    liveOwnerId: string | null;
    initialOwnerId: string;
}) {
    return sessionStatus === 'loading'
        ? (liveOwnerId ?? initialOwnerId)
        : liveOwnerId;
}

export function isNotificationSettingsRunCurrent({
    run,
    epoch,
    generation,
    currentGeneration,
}: {
    run: OwnerRunToken;
    epoch: OwnerEpoch;
    generation: number;
    currentGeneration: number;
}) {
    return (
        generation === currentGeneration &&
        isOwnerRunCurrent(run, epoch)
    );
}

export async function disableWebPushForOwner({
    ownerId,
    signal,
    isCurrent,
    serviceWorker,
}: {
    ownerId: string;
    signal: AbortSignal;
    isCurrent: () => boolean;
    serviceWorker: Pick<ServiceWorkerContainer, 'getRegistration'> | null;
}): Promise<Preferences | null> {
    const preferenceResponse = await fetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            [EXPECTED_OWNER_HEADER]: ownerId,
        },
        body: JSON.stringify({ pushEnabled: false }),
        signal,
    });
    const preferencePayload = await preferenceResponse.json().catch(() => ({})) as {
        ownerId?: string;
        preferences?: Preferences;
        error?: string;
    };
    if (!isCurrent()) return null;
    if (
        !preferenceResponse.ok ||
        preferencePayload.ownerId !== ownerId ||
        !preferencePayload.preferences
    ) {
        throw new Error(preferencePayload.error ?? 'Could not disable Web Push.');
    }

    const registration = await serviceWorker?.getRegistration('/');
    if (!isCurrent()) return null;
    const subscription = await registration?.pushManager.getSubscription();
    if (!isCurrent()) return null;
    if (subscription) {
        const response = await fetch(
            `/api/notifications/push-subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`,
            {
                method: 'DELETE',
                headers: { [EXPECTED_OWNER_HEADER]: ownerId },
                signal,
            }
        );
        const payload = await response.json().catch(() => ({})) as {
            ownerId?: string;
            error?: string;
        };
        if (!isCurrent()) return null;
        if (!response.ok || payload.ownerId !== ownerId) {
            throw new Error(payload.error ?? 'Could not remove the local Web Push subscription.');
        }
        await subscription.unsubscribe();
        if (!isCurrent()) return null;
    }
    return preferencePayload.preferences;
}

export function NotificationSettingsCard({ ownerId: initialOwnerId }: { ownerId: string }) {
    const { data: session, status: sessionStatus } = useSession();
    const liveOwnerId = session?.user?.id ?? null;
    const ownerId = resolveNotificationSettingsOwnerId({
        sessionStatus,
        liveOwnerId,
        initialOwnerId,
    });
    const ownerEpochRef = React.useRef<OwnerEpoch>({ ownerId: null, generation: 0 });
    ownerEpochRef.current = advanceOwnerEpoch(ownerEpochRef.current, ownerId);
    const loadControllerRef = React.useRef<AbortController | null>(null);
    const mutationControllerRef = React.useRef<AbortController | null>(null);
    const loadGenerationRef = React.useRef(0);
    const mutationGenerationRef = React.useRef(0);
    const [preferences, setPreferences] = React.useState<Preferences | null>(null);
    const [loadedOwnerId, setLoadedOwnerId] = React.useState<string | null>(null);
    const [vapidPublicKey, setVapidPublicKey] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        const run = captureOwnerRun(ownerEpochRef.current);
        const generation = ++loadGenerationRef.current;
        loadControllerRef.current?.abort();
        setLoadedOwnerId(null);
        setPreferences(null);
        setVapidPublicKey(null);
        setSaving(false);
        setLoadError(null);
        if (!run) {
            setLoadError('Your session changed. Reload Settings to continue.');
            return;
        }
        const controller = new AbortController();
        loadControllerRef.current = controller;
        const isCurrent = () =>
            !controller.signal.aborted &&
            isNotificationSettingsRunCurrent({
                run,
                epoch: ownerEpochRef.current,
                generation,
                currentGeneration: loadGenerationRef.current,
            });
        try {
            const response = await fetch('/api/notifications/preferences', {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error('Could not load notification settings');
            }
            const payload = (await response.json()) as {
                ownerId?: string;
                preferences: Preferences;
                vapidPublicKey: string | null;
            };
            if (!isCurrent()) return;
            if (payload.ownerId !== run.ownerId) {
                throw new Error('The server returned notification settings for a different account.');
            }
            setPreferences(payload.preferences);
            setVapidPublicKey(payload.vapidPublicKey);
            setLoadedOwnerId(run.ownerId);
        } catch (error) {
            if (!isCurrent()) return;
            const message =
                error instanceof Error
                    ? error.message
                    : 'Could not load settings';
            setPreferences(null);
            setLoadError(message);
            toast.error(message);
        } finally {
            if (loadControllerRef.current === controller) {
                loadControllerRef.current = null;
            }
        }
    }, []);

    React.useEffect(() => {
        void load();
        return () => {
            loadControllerRef.current?.abort();
            mutationControllerRef.current?.abort();
        };
    }, [load, ownerId]);

    const ownerReady = Boolean(ownerId && loadedOwnerId === ownerId);

    async function save(patch: Partial<Preferences>) {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!preferences || !run || loadedOwnerId !== run.ownerId) return;
        const generation = ++mutationGenerationRef.current;
        mutationControllerRef.current?.abort();
        const controller = new AbortController();
        mutationControllerRef.current = controller;
        const isCurrent = () =>
            !controller.signal.aborted &&
            isNotificationSettingsRunCurrent({
                run,
                epoch: ownerEpochRef.current,
                generation,
                currentGeneration: mutationGenerationRef.current,
            }) &&
            loadedOwnerId === run.ownerId;
        const previous = preferences;
        setPreferences((current) => current ? { ...current, ...patch } : current);
        setSaving(true);
        try {
            const response = await fetch('/api/notifications/preferences', {
                method: 'PATCH',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: run.ownerId,
                },
                body: JSON.stringify(patch),
                signal: controller.signal,
            });
            const payload = await response.json().catch(() => ({})) as {
                ownerId?: string;
                preferences?: Preferences;
                error?: string;
            };
            if (!isCurrent()) return;
            if (!response.ok || !payload.preferences) throw new Error(payload.error ?? 'Save failed');
            if (payload.ownerId !== run.ownerId) {
                throw new Error('The server saved notification settings for a different account.');
            }
            setPreferences(payload.preferences);
        } catch (error) {
            if (!isCurrent()) return;
            setPreferences(previous);
            toast.error(error instanceof Error ? error.message : 'Save failed');
        } finally {
            if (mutationControllerRef.current === controller) {
                mutationControllerRef.current = null;
            }
            if (isCurrent()) setSaving(false);
        }
    }

    async function togglePush(enabled: boolean) {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!preferences || !run || loadedOwnerId !== run.ownerId) return;
        const generation = ++mutationGenerationRef.current;
        mutationControllerRef.current?.abort();
        const controller = new AbortController();
        mutationControllerRef.current = controller;
        const isCurrent = () =>
            !controller.signal.aborted &&
            isNotificationSettingsRunCurrent({
                run,
                epoch: ownerEpochRef.current,
                generation,
                currentGeneration: mutationGenerationRef.current,
            }) &&
            loadedOwnerId === run.ownerId;
        const ownerHeaders = { [EXPECTED_OWNER_HEADER]: run.ownerId };
        setSaving(true);
        try {
        if (!enabled) {
            const nextPreferences = await disableWebPushForOwner({
                ownerId: run.ownerId,
                signal: controller.signal,
                isCurrent,
                serviceWorker:
                    'serviceWorker' in navigator
                        ? navigator.serviceWorker
                        : null,
            });
            if (nextPreferences && isCurrent()) {
                setPreferences(nextPreferences);
                toast.success('Web Push disabled.');
            }
            return;
        }
        if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
            toast.error('Web Push is not available on this device.');
            return;
        }
        const permission = await Notification.requestPermission();
        if (!isCurrent()) return;
        if (permission !== 'granted') {
            toast.error('Notification permission was not granted.');
            return;
        }
        const registration = await navigator.serviceWorker.register('/serwist/sw.js', { scope: '/' });
        if (!isCurrent()) return;
        const subscription =
            (await registration.pushManager.getSubscription()) ??
            (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(vapidPublicKey),
            }));
        if (!isCurrent()) return;
        const response = await fetch('/api/notifications/push-subscription', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...ownerHeaders,
            },
            body: JSON.stringify(subscription.toJSON()),
            signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as { ownerId?: string; error?: string };
        if (!isCurrent()) return;
        if (!response.ok || payload.ownerId !== run.ownerId) {
            throw new Error(payload.error ?? 'Could not enable Web Push.');
        }
        setPreferences((current) => current ? { ...current, pushEnabled: true } : current);
        toast.success('Web Push enabled.');
        } catch (error) {
            if (!isCurrent()) return;
            toast.error(error instanceof Error ? error.message : 'Could not change Web Push.');
        } finally {
            if (mutationControllerRef.current === controller) {
                mutationControllerRef.current = null;
            }
            if (isCurrent()) setSaving(false);
        }
    }

    return (
        <Card variant="panel" className="overflow-hidden">
            <CardHeader className="gap-3 border-b border-border/70 bg-surface-subtle/50 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
                <div className="space-y-1.5">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <BellRing className="h-4 w-4" aria-hidden="true" />
                        </span>
                        Notification rhythm
                    </CardTitle>
                    <CardDescription>Choose which updates can reach you outside the app.</CardDescription>
                </div>
                {saving ? (
                    <Badge variant="outline" className="w-fit bg-card text-muted-foreground">
                        Saving…
                    </Badge>
                ) : null}
            </CardHeader>
            <CardContent className="space-y-6 pt-5">
                {loadError ? (
                    <ErrorState
                        title="Notifications unavailable"
                        description={loadError}
                        action={
                            <Button type="button" variant="outline" onClick={() => void load()}>
                                Try again
                            </Button>
                        }
                        className="border-0"
                    />
                ) : !preferences ? (
                    <div role="status" aria-label="Loading notification settings">
                        <ListSkeleton rows={3} />
                    </div>
                ) : (
                    <>
                        {preferences.emailSuppressedAt ? (
                            <InlineStatus tone="danger">
                                Email delivery is paused after a bounce or spam complaint. Contact support to restore it.
                            </InlineStatus>
                        ) : null}
                        <div className="space-y-2">
                            <div className="pb-1">
                                <h3 className="text-sm font-semibold">Email updates</h3>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    Transactional account email is always sent when required.
                                </p>
                            </div>
                            {EMAIL_OPTIONS.map((option) => (
                                <PreferenceCheckbox
                                    key={option.key}
                                    checked={Boolean(preferences[option.key])}
                                    disabled={!ownerReady || saving || !!preferences.emailSuppressedAt}
                                    label={option.label}
                                    description={option.description}
                                    onChange={(checked) => void save({ [option.key]: checked })}
                                />
                            ))}
                        </div>
                        <div className="grid gap-4 rounded-lg border border-border/70 bg-surface-subtle/45 p-3 sm:p-4 md:grid-cols-3">
                            <label className="space-y-2 text-sm">
                                <span className="font-medium">Game sync digest</span>
                                <Select
                                    value={preferences.syncDigestFrequency}
                                    disabled={!ownerReady || saving}
                                    onValueChange={(value) => void save({
                                        syncDigestFrequency: value as Preferences['syncDigestFrequency'],
                                        emailSyncSummary: value !== 'OFF',
                                    })}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="OFF">Off</SelectItem>
                                        <SelectItem value="DAILY">Daily</SelectItem>
                                        <SelectItem value="WEEKLY">Weekly</SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>
                            <label className="space-y-2 text-sm">
                                <span className="font-medium">Timezone</span>
                                <Input
                                    value={preferences.timezone}
                                    disabled={!ownerReady || saving}
                                    onChange={(event) => setPreferences({ ...preferences, timezone: event.target.value })}
                                    onBlur={() => void save({ timezone: preferences.timezone })}
                                    placeholder="Europe/Prague"
                                />
                            </label>
                            <label className="space-y-2 text-sm">
                                <span className="font-medium">Digest hour</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={preferences.digestHour}
                                    disabled={!ownerReady || saving}
                                    onChange={(event) => setPreferences({ ...preferences, digestHour: Number(event.target.value) })}
                                    onBlur={() => void save({ digestHour: preferences.digestHour })}
                                />
                            </label>
                        </div>
                        <div className="flex flex-col gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <p className="text-sm font-medium">Web Push</p>
                                <p className="text-sm text-muted-foreground">Receive alerts when Backranq is closed.</p>
                            </div>
                            <Button
                                variant={preferences.pushEnabled ? 'outline' : 'default'}
                                disabled={!ownerReady || saving}
                                onClick={() => void togglePush(!preferences.pushEnabled)}
                            >
                                {preferences.pushEnabled ? 'Disable' : 'Enable'}
                            </Button>
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function PreferenceCheckbox(props: {
    checked: boolean;
    disabled: boolean;
    label: string;
    description: string;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="flex min-h-14 items-start gap-3 rounded-md border border-transparent px-2.5 py-2 transition-colors hover:border-border/70 hover:bg-surface-subtle/60">
            <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 rounded border-input accent-primary"
                checked={props.checked}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.checked)}
            />
            <span>
                <span className="block text-sm font-medium">{props.label}</span>
                <span className="block text-sm text-muted-foreground">{props.description}</span>
            </span>
        </label>
    );
}

function base64UrlToBytes(value: string) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
