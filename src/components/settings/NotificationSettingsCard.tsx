'use client';

import * as React from 'react';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { ErrorState, InlineStatus } from '@/components/ui/async-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ListSkeleton } from '@/components/ui/loading-patterns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Preferences = {
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

const EMAIL_OPTIONS: Array<{ key: keyof Preferences; label: string; description: string }> = [
    { key: 'emailPracticeReady', label: 'New practice ready', description: 'One quiet daily email at most, combining everything that became ready.' },
    { key: 'emailAnalysisFailed', label: 'Analysis and sync failures', description: 'Off by default; failures always remain visible in the app.' },
    { key: 'emailBilling', label: 'Billing and paused analysis', description: 'Important payment issues or automation stopped at your credit reserve.' },
    { key: 'emailWeeklyProgress', label: 'Weekly progress', description: 'A weekly recap of your practice activity.' },
    { key: 'emailProductNews', label: 'Product news', description: 'Optional Backranq features and announcements.' },
];

export function NotificationSettingsCard() {
    const [preferences, setPreferences] = React.useState<Preferences | null>(null);
    const [vapidPublicKey, setVapidPublicKey] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setLoadError(null);
        try {
            const response = await fetch('/api/notifications/preferences', {
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error('Could not load notification settings');
            }
            const payload = (await response.json()) as {
                preferences: Preferences;
                vapidPublicKey: string | null;
            };
            setPreferences(payload.preferences);
            setVapidPublicKey(payload.vapidPublicKey);
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Could not load settings';
            setPreferences(null);
            setLoadError(message);
            toast.error(message);
        }
    }, []);

    React.useEffect(() => {
        void load();
    }, [load]);

    async function save(patch: Partial<Preferences>) {
        if (!preferences) return;
        const previous = preferences;
        setPreferences({ ...preferences, ...patch });
        setSaving(true);
        try {
            const response = await fetch('/api/notifications/preferences', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch),
            });
            const payload = await response.json().catch(() => ({})) as { preferences?: Preferences; error?: string };
            if (!response.ok || !payload.preferences) throw new Error(payload.error ?? 'Save failed');
            setPreferences(payload.preferences);
        } catch (error) {
            setPreferences(previous);
            toast.error(error instanceof Error ? error.message : 'Save failed');
        } finally {
            setSaving(false);
        }
    }

    async function togglePush(enabled: boolean) {
        if (!preferences) return;
        if (!enabled) {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await fetch(`/api/notifications/push-subscription?endpoint=${encodeURIComponent(subscription.endpoint)}`, { method: 'DELETE' });
                await subscription.unsubscribe();
            }
            await save({ pushEnabled: false });
            return;
        }
        if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
            toast.error('Web Push is not available on this device.');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            toast.error('Notification permission was not granted.');
            return;
        }
        const registration = await navigator.serviceWorker.register('/serwist/sw.js', { scope: '/' });
        const subscription =
            (await registration.pushManager.getSubscription()) ??
            (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(vapidPublicKey),
            }));
        const response = await fetch('/api/notifications/push-subscription', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(subscription.toJSON()),
        });
        if (!response.ok) {
            toast.error('Could not enable Web Push.');
            return;
        }
        setPreferences({ ...preferences, pushEnabled: true });
        toast.success('Web Push enabled.');
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
                                    disabled={saving || !!preferences.emailSuppressedAt}
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
                                    disabled={saving}
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
                                    disabled={saving}
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
                                    disabled={saving}
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
                                disabled={saving}
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
