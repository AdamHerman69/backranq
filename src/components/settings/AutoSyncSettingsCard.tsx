'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    Cloud,
    Cpu,
} from 'lucide-react';
import { toast } from 'sonner';

import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import {
    CHESS_CONNECTIONS_CHANGED_EVENT,
    humanizeAutomationBlockReason,
} from '@/components/sync/syncClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
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
} from '@/lib/preferences';
import {
    getSyncStatus,
    type SyncProviderState,
    type SyncStatus,
} from '@/lib/services/gameSync';

type ProviderKey = 'lichess' | 'chesscom';
type TimeControlKey =
    | 'bullet'
    | 'blitz'
    | 'rapid'
    | 'classical'
    | 'unknown';
type ResultScope = 'losses' | 'draws' | 'all';
type BacklogMode = 'new' | 'all';
type AutomationSyncStatus = SyncStatus & {
    automation?: {
        capacity?: {
            reservableCredits: number;
            currentBalance: number;
            reserveCredits: number;
            dailyRemaining: number | null;
            monthlyRemaining: number | null;
            planMonthlyRemaining: number;
            blockingReason: string | null;
        };
    };
};

export type AutomationDraft = {
    autoSyncEnabled: boolean;
    autoSyncProviders: Record<ProviderKey, boolean>;
    autoAnalysis: {
        enabled: boolean;
        providers: Record<ProviderKey, boolean>;
        resultScope: ResultScope;
        timeControls: Record<TimeControlKey, boolean>;
        ratedOnly: boolean;
        minPlies: string;
        dailyCap: string;
        monthlyCap: string;
        reserveCredits: string;
        backlogMode: BacklogMode;
    };
};

type ExtendedAutoAnalysis = NonNullable<
    PreferencesSchema['autoAnalysis']
> & {
    reserveCredits?: number | string | null;
    backlogMode?: BacklogMode;
};

const TIME_CONTROLS: Array<{ key: TimeControlKey; label: string }> = [
    { key: 'bullet', label: 'Bullet' },
    { key: 'blitz', label: 'Blitz' },
    { key: 'rapid', label: 'Rapid' },
    { key: 'classical', label: 'Classical' },
    { key: 'unknown', label: 'Unknown' },
];

function inputString(value: number | string | null | undefined) {
    return value == null ? '' : String(value);
}

export function automationDraftFromPreferences(
    preferences: PreferencesSchema
): AutomationDraft {
    const fallback = defaultPreferences();
    const raw = (preferences.autoAnalysis ??
        fallback.autoAnalysis ??
        {}) as ExtendedAutoAnalysis;
    const fallbackAnalysis = (fallback.autoAnalysis ??
        {}) as ExtendedAutoAnalysis;
    return {
        autoSyncEnabled: preferences.autoSyncEnabled,
        autoSyncProviders: {
            lichess: preferences.autoSyncProviders.lichess,
            chesscom: preferences.autoSyncProviders.chesscom,
        },
        autoAnalysis: {
            enabled: raw.enabled ?? fallbackAnalysis.enabled ?? false,
            providers: {
                lichess:
                    raw.providers?.lichess ??
                    fallbackAnalysis.providers?.lichess ??
                    true,
                chesscom:
                    raw.providers?.chesscom ??
                    fallbackAnalysis.providers?.chesscom ??
                    true,
            },
            resultScope:
                raw.resultScope ??
                fallbackAnalysis.resultScope ??
                'draws',
            timeControls: {
                bullet:
                    raw.timeControls?.bullet ??
                    fallbackAnalysis.timeControls?.bullet ??
                    false,
                blitz:
                    raw.timeControls?.blitz ??
                    fallbackAnalysis.timeControls?.blitz ??
                    false,
                rapid:
                    raw.timeControls?.rapid ??
                    fallbackAnalysis.timeControls?.rapid ??
                    true,
                classical:
                    raw.timeControls?.classical ??
                    fallbackAnalysis.timeControls?.classical ??
                    true,
                unknown:
                    raw.timeControls?.unknown ??
                    fallbackAnalysis.timeControls?.unknown ??
                    false,
            },
            ratedOnly:
                raw.ratedOnly ?? fallbackAnalysis.ratedOnly ?? true,
            minPlies: inputString(
                raw.minPlies ?? fallbackAnalysis.minPlies
            ),
            dailyCap: inputString(
                raw.dailyCap ?? fallbackAnalysis.dailyCap
            ),
            monthlyCap: inputString(
                raw.monthlyCap ?? fallbackAnalysis.monthlyCap
            ),
            reserveCredits: inputString(
                raw.reserveCredits ?? fallbackAnalysis.reserveCredits ?? 10
            ),
            backlogMode: raw.backlogMode ?? 'new',
        },
    };
}

function optionalInteger(
    value: string,
    min: number,
    max: number
): number | null | undefined {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    if (
        !Number.isSafeInteger(number) ||
        number < min ||
        number > max
    ) {
        return undefined;
    }
    return number;
}

export function validateAutomationDraft(
    draft: AutomationDraft
): string | null {
    if (
        !draft.autoSyncProviders.lichess &&
        !draft.autoSyncProviders.chesscom &&
        draft.autoSyncEnabled
    ) {
        return 'Choose at least one source for automatic game updates.';
    }
    if (draft.autoAnalysis.enabled) {
        if (
            !draft.autoAnalysis.providers.lichess &&
            !draft.autoAnalysis.providers.chesscom
        ) {
            return 'Choose at least one source for automatic analysis.';
        }
        if (!Object.values(draft.autoAnalysis.timeControls).some(Boolean)) {
            return 'Choose at least one time control for automatic analysis.';
        }
    }
    if (
        optionalInteger(draft.autoAnalysis.minPlies, 0, 1_000) == null
    ) {
        return 'Minimum game length must be a whole number from 0 to 1,000 plies.';
    }
    if (
        optionalInteger(draft.autoAnalysis.dailyCap, 1, 10_000) === undefined
    ) {
        return 'Daily personal cap must be a positive whole number or blank.';
    }
    if (
        optionalInteger(draft.autoAnalysis.monthlyCap, 1, 100_000) ===
        undefined
    ) {
        return 'Monthly personal cap must be a positive whole number or blank.';
    }
    if (
        optionalInteger(draft.autoAnalysis.reserveCredits, 0, 100_000) ==
        null
    ) {
        return 'Credit reserve must be a whole number of zero or more.';
    }
    const daily = optionalInteger(
        draft.autoAnalysis.dailyCap,
        1,
        10_000
    );
    const monthly = optionalInteger(
        draft.autoAnalysis.monthlyCap,
        1,
        100_000
    );
    if (
        typeof daily === 'number' &&
        typeof monthly === 'number' &&
        daily > monthly
    ) {
        return 'Daily personal cap cannot exceed the monthly personal cap.';
    }
    return null;
}

export function automationPreferencesPatch(draft: AutomationDraft) {
    return {
        autoSyncEnabled: draft.autoSyncEnabled,
        autoSyncProviders: draft.autoSyncProviders,
        autoAnalysis: {
            enabled: draft.autoAnalysis.enabled,
            providers: draft.autoAnalysis.providers,
            resultScope: draft.autoAnalysis.resultScope,
            timeControls: draft.autoAnalysis.timeControls,
            ratedOnly: draft.autoAnalysis.ratedOnly,
            minPlies: optionalInteger(
                draft.autoAnalysis.minPlies,
                0,
                1_000
            ) as number,
            dailyCap: optionalInteger(
                draft.autoAnalysis.dailyCap,
                1,
                10_000
            ),
            monthlyCap: optionalInteger(
                draft.autoAnalysis.monthlyCap,
                1,
                100_000
            ),
            reserveCredits: optionalInteger(
                draft.autoAnalysis.reserveCredits,
                0,
                100_000
            ) as number,
            backlogMode: draft.autoAnalysis.backlogMode,
        },
    };
}

function formatDate(value: string | null | undefined) {
    return value ? new Date(value).toLocaleString() : 'Not yet';
}

function ProviderStatus({
    label,
    username,
    state,
}: {
    label: string;
    username: string | null | undefined;
    state: SyncProviderState | null | undefined;
}) {
    return (
        <div className="min-w-0 space-y-1 rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{label}</span>
                <Badge variant={username ? 'secondary' : 'outline'}>
                    {username
                        ? `@${username}`
                        : username === undefined
                          ? 'Status unavailable'
                          : 'Not connected'}
                </Badge>
            </div>
            {username === undefined ? (
                <p className="text-xs text-muted-foreground">
                    Connection status could not be loaded. Saved preferences
                    were left unchanged.
                </p>
            ) : username ? (
                <div className="space-y-0.5 text-xs text-muted-foreground">
                    <div>Last success: {formatDate(state?.lastSuccessAt)}</div>
                    <div>Last checked: {formatDate(state?.lastAttemptAt)}</div>
                    {state?.lastError ? (
                        <div className="break-words text-destructive">
                            {state.lastError}
                        </div>
                    ) : null}
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    Add a username in Linked accounts above.
                </p>
            )}
        </div>
    );
}

export function AutoSyncSettingsCard({ ownerId: serverOwnerId }: {
    ownerId: string;
}) {
    const { data: session, status: sessionStatus } = useSession();
    const activeOwnerId =
        sessionStatus === 'authenticated'
            ? session?.user?.id ?? null
            : null;
    const ownerEpochRef = React.useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        activeOwnerId
    );
    const ownerReady =
        sessionStatus === 'authenticated' &&
        activeOwnerId === serverOwnerId;
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [status, setStatus] =
        React.useState<AutomationSyncStatus | null>(null);
    const [draft, setDraft] = React.useState<AutomationDraft | null>(null);
    const [saved, setSaved] = React.useState<AutomationDraft | null>(null);
    const [enableConfirmOpen, setEnableConfirmOpen] = React.useState(false);
    const requestIdRef = React.useRef(0);
    const statusRequestIdRef = React.useRef(0);
    const saveRequestIdRef = React.useRef(0);

    const runIsCurrent = React.useCallback(
        (run: OwnerRunToken) =>
            run.ownerId === serverOwnerId &&
            isOwnerRunCurrent(run, ownerEpochRef.current),
        [serverOwnerId]
    );

    const load = React.useCallback(async () => {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) return;
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setLoadError(null);
        const preferencesResult = await Promise.resolve(
            fetch('/api/user/preferences', { cache: 'no-store' }).then(
                async (response) => {
                    const body = (await response
                        .json()
                        .catch(() => ({}))) as {
                        ownerId?: string;
                        preferences?: PreferencesSchema;
                        error?: string;
                    };
                    if (
                        !response.ok ||
                        !body.preferences ||
                        body.ownerId !== run.ownerId
                    ) {
                        throw new Error(
                            body.ownerId &&
                                body.ownerId !== run.ownerId
                                ? 'The server returned settings for a different account. Reload Settings.'
                                : body.error ??
                                'Could not load automation preferences'
                        );
                    }
                    return body.preferences;
                }
            )
        ).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason })
        );
        if (
            requestId !== requestIdRef.current ||
            !runIsCurrent(run)
        ) {
            return;
        }

        if (preferencesResult.status === 'fulfilled') {
            const next = automationDraftFromPreferences(
                preferencesResult.value
            );
            setDraft(next);
            setSaved(next);
        } else {
            setDraft(null);
            setSaved(null);
            setLoadError(
                preferencesResult.reason instanceof Error
                    ? preferencesResult.reason.message
                    : 'Could not load automation preferences'
            );
        }
        setLoading(false);
    }, [runIsCurrent]);

    const refreshConnectionStatus = React.useCallback(async () => {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) return;
        const requestId = ++statusRequestIdRef.current;
        try {
            const next = (await getSyncStatus()) as AutomationSyncStatus;
            if (
                requestId === statusRequestIdRef.current &&
                runIsCurrent(run)
            ) {
                if (next.ownerId !== run.ownerId) {
                    requestIdRef.current += 1;
                    setDraft(null);
                    setSaved(null);
                    setStatus(null);
                    setLoadError(
                        'The server returned source status for a different account. Reload Settings.'
                    );
                    setLoading(false);
                    return;
                }
                setStatus(next);
            }
        } catch {
            if (
                requestId === statusRequestIdRef.current &&
                runIsCurrent(run)
            ) {
                setStatus(null);
            }
        }
    }, [runIsCurrent]);

    React.useEffect(() => {
        requestIdRef.current += 1;
        statusRequestIdRef.current += 1;
        saveRequestIdRef.current += 1;
        setDraft(null);
        setSaved(null);
        setStatus(null);
        setSaving(false);
        setEnableConfirmOpen(false);
        if (!ownerReady) {
            setLoading(sessionStatus === 'loading');
            setLoadError(
                sessionStatus === 'loading'
                    ? null
                    : 'Your signed-in account changed. Reload Settings before editing automation.'
            );
            return;
        }
        void Promise.all([load(), refreshConnectionStatus()]);
        const reload = () => void refreshConnectionStatus();
        window.addEventListener(CHESS_CONNECTIONS_CHANGED_EVENT, reload);
        return () => {
            requestIdRef.current += 1;
            statusRequestIdRef.current += 1;
            window.removeEventListener(
                CHESS_CONNECTIONS_CHANGED_EVENT,
                reload
            );
        };
    }, [
        load,
        ownerReady,
        refreshConnectionStatus,
        sessionStatus,
    ]);

    function updateDraft(
        updater: (current: AutomationDraft) => AutomationDraft
    ) {
        setDraft((current) => (current ? updater(current) : current));
    }

    const validationError = draft
        ? validateAutomationDraft(draft)
        : null;
    const dirty =
        !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

    async function save() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (
            !draft ||
            !dirty ||
            validationError ||
            saving ||
            !run ||
            !runIsCurrent(run)
        ) {
            return;
        }
        const requestId = ++saveRequestIdRef.current;
        setSaving(true);
        const toastId = toast.loading('Saving automation settings…');
        try {
            const response = await fetch('/api/user/preferences', {
                method: 'PUT',
                headers: {
                    'content-type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: run.ownerId,
                },
                body: JSON.stringify(automationPreferencesPatch(draft)),
            });
            const body = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok) {
                throw new Error(body.error ?? 'Save failed');
            }
            if (
                body.ownerId !== run.ownerId ||
                !body.preferences
            ) {
                requestIdRef.current += 1;
                statusRequestIdRef.current += 1;
                setDraft(null);
                setSaved(null);
                setStatus(null);
                setLoadError(
                    'The server could not confirm which account was updated. Reload Settings before trying again.'
                );
                setLoading(false);
                throw new Error(
                    'The server could not confirm which account was updated. Reload Settings before trying again.'
                );
            }
            if (
                requestId !== saveRequestIdRef.current ||
                !runIsCurrent(run)
            ) {
                toast.dismiss(toastId);
                return;
            }
            const next = automationDraftFromPreferences(body.preferences);
            setDraft(next);
            setSaved(next);
            toast.success('Automation settings saved.', { id: toastId });
            try {
                await refreshConnectionStatus();
            } catch {
                // Preferences were saved; status can be refreshed separately.
            }
        } catch (error) {
            if (
                requestId !== saveRequestIdRef.current ||
                !runIsCurrent(run)
            ) {
                toast.dismiss(toastId);
                return;
            }
            toast.error(
                error instanceof Error ? error.message : 'Save failed',
                { id: toastId }
            );
        } finally {
            if (
                requestId === saveRequestIdRef.current &&
                runIsCurrent(run)
            ) {
                setSaving(false);
            }
        }
    }

    if (loading) {
        return (
            <Card aria-live="polite">
                <CardContent className="py-6 text-sm text-muted-foreground">
                    Loading game automation settings…
                </CardContent>
            </Card>
        );
    }

    if (!draft || loadError) {
        return (
            <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-6">
                    <div className="flex items-start gap-2 text-sm">
                        <AlertCircle
                            className="mt-0.5 h-4 w-4 text-destructive"
                            aria-hidden="true"
                        />
                        <div>
                            <div className="font-medium">
                                Automation settings unavailable
                            </div>
                            <div className="text-muted-foreground">
                                {loadError ??
                                    'Your saved settings were not changed.'}
                            </div>
                        </div>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!ownerReady}
                        onClick={() => void load()}
                    >
                        Try again
                    </Button>
                </CardContent>
            </Card>
        );
    }

    const linked = status?.linked;
    const syncStates = status?.autoSync?.states;
    const capacity = status?.automation?.capacity;
    const billing = status?.billing;

    return (
        <div className="space-y-6">
            <Card id="connections">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Cloud className="h-4 w-4" aria-hidden="true" />
                        Keep games up to date
                    </CardTitle>
                    <CardDescription>
                        Import new public games automatically. Syncing does not
                        use analysis credits.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <label className="flex items-start justify-between gap-4 rounded-md border p-3 text-sm">
                        <span className="min-w-0">
                            <span className="block font-medium">
                                Automatically import new games
                            </span>
                            <span className="block text-muted-foreground">
                                Backranq periodically checks the selected
                                sources. You can still use Sync now at any time.
                            </span>
                        </span>
                        <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 accent-foreground"
                            checked={draft.autoSyncEnabled}
                            disabled={saving}
                            onChange={(event) =>
                                updateDraft((current) => ({
                                    ...current,
                                    autoSyncEnabled: event.target.checked,
                                }))
                            }
                        />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-2">
                        {(
                            [
                                ['lichess', 'Lichess'],
                                ['chesscom', 'Chess.com'],
                            ] as const
                        ).map(([provider, label]) => {
                            const username =
                                status === null
                                    ? undefined
                                    : provider === 'lichess'
                                      ? linked?.lichessUsername ?? null
                                      : linked?.chesscomUsername ?? null;
                            return (
                                <div key={provider} className="space-y-2">
                                    <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                                        <span>
                                            Keep {label} games up to date
                                        </span>
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 shrink-0 accent-foreground"
                                            checked={
                                                draft.autoSyncProviders[
                                                    provider
                                                ]
                                            }
                                            disabled={
                                                saving ||
                                                !draft.autoSyncEnabled ||
                                                username === null
                                            }
                                            onChange={(event) =>
                                                updateDraft((current) => ({
                                                    ...current,
                                                    autoSyncProviders: {
                                                        ...current.autoSyncProviders,
                                                        [provider]:
                                                            event.target
                                                                .checked,
                                                    },
                                                }))
                                            }
                                        />
                                    </label>
                                    <ProviderStatus
                                        label={label}
                                        username={username}
                                        state={syncStates?.[provider]}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </CardContent>
            </Card>

            <Card id="automatic-analysis">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Cpu className="h-4 w-4" aria-hidden="true" />
                        Automatic analysis
                    </CardTitle>
                    <CardDescription>
                        Decide which imported games may use server analysis.
                        Importing and analysis remain independent.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <label className="flex items-start justify-between gap-4 rounded-md border p-3 text-sm">
                        <span className="min-w-0">
                            <span className="block font-medium">
                                Analyze matching games on the server
                            </span>
                            <span className="block text-muted-foreground">
                                Explicit opt-in. Server analysis continues when
                                the app is closed and spends credits within the
                                limits below.
                            </span>
                        </span>
                        <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 accent-foreground"
                            checked={draft.autoAnalysis.enabled}
                            disabled={saving}
                            onChange={(event) => {
                                if (
                                    event.target.checked &&
                                    !draft.autoAnalysis.enabled
                                ) {
                                    setEnableConfirmOpen(true);
                                    return;
                                }
                                updateDraft((current) => ({
                                    ...current,
                                    autoAnalysis: {
                                        ...current.autoAnalysis,
                                        enabled: false,
                                    },
                                }));
                            }}
                        />
                    </label>

                    <fieldset
                        className="space-y-4 disabled:opacity-60"
                        disabled={!draft.autoAnalysis.enabled || saving}
                    >
                        <legend className="sr-only">
                            Automatic analysis policy
                        </legend>

                        <div>
                            <div className="mb-2 text-sm font-medium">
                                Sources
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                                {(
                                    [
                                        ['lichess', 'Lichess'],
                                        ['chesscom', 'Chess.com'],
                                    ] as const
                                ).map(([provider, label]) => {
                                    const connected =
                                        status === null
                                            ? null
                                            : provider === 'lichess'
                                              ? !!linked?.lichessUsername
                                              : !!linked?.chesscomUsername;
                                    return (
                                        <label
                                            key={provider}
                                            className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
                                        >
                                            <span>
                                                {label}
                                                {connected === false ? (
                                                    <span className="ml-1 text-xs text-muted-foreground">
                                                        (not connected)
                                                    </span>
                                                ) : null}
                                            </span>
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4 accent-foreground"
                                                checked={
                                                    draft.autoAnalysis
                                                        .providers[provider]
                                                }
                                                disabled={
                                                    !draft.autoAnalysis
                                                        .enabled ||
                                                    saving ||
                                                    connected === false
                                                }
                                                onChange={(event) =>
                                                    updateDraft((current) => ({
                                                        ...current,
                                                        autoAnalysis: {
                                                            ...current.autoAnalysis,
                                                            providers: {
                                                                ...current
                                                                    .autoAnalysis
                                                                    .providers,
                                                                [provider]:
                                                                    event.target
                                                                        .checked,
                                                            },
                                                        },
                                                    }))
                                                }
                                            />
                                        </label>
                                    );
                                })}
                            </div>
                        </div>

                        <div>
                            <div className="mb-2 text-sm font-medium">
                                Time controls
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {TIME_CONTROLS.map(({ key, label }) => (
                                    <label
                                        key={key}
                                        className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                                    >
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 accent-foreground"
                                            checked={
                                                draft.autoAnalysis.timeControls[
                                                    key
                                                ]
                                            }
                                            onChange={(event) =>
                                                updateDraft((current) => ({
                                                    ...current,
                                                    autoAnalysis: {
                                                        ...current.autoAnalysis,
                                                        timeControls: {
                                                            ...current
                                                                .autoAnalysis
                                                                .timeControls,
                                                            [key]:
                                                                event.target
                                                                    .checked,
                                                        },
                                                    },
                                                }))
                                            }
                                        />
                                        {label}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <label className="space-y-1.5 text-sm">
                                <span className="font-medium">Results</span>
                                <Select
                                    value={draft.autoAnalysis.resultScope}
                                    onValueChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            autoAnalysis: {
                                                ...current.autoAnalysis,
                                                resultScope:
                                                    value as ResultScope,
                                            },
                                        }))
                                    }
                                >
                                    <SelectTrigger aria-label="Games by result">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="losses">
                                            Losses only
                                        </SelectItem>
                                        <SelectItem value="draws">
                                            Losses and draws
                                        </SelectItem>
                                        <SelectItem value="all">
                                            All results
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>

                            <label className="flex items-center justify-between gap-3 self-end rounded-md border px-3 py-2 text-sm">
                                <span>Rated games only</span>
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 accent-foreground"
                                    checked={draft.autoAnalysis.ratedOnly}
                                    onChange={(event) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            autoAnalysis: {
                                                ...current.autoAnalysis,
                                                ratedOnly:
                                                    event.target.checked,
                                            },
                                        }))
                                    }
                                />
                            </label>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <NumericField
                                label="Daily personal cap"
                                value={draft.autoAnalysis.dailyCap}
                                placeholder="No personal cap"
                                onChange={(value) =>
                                    updateDraft((current) => ({
                                        ...current,
                                        autoAnalysis: {
                                            ...current.autoAnalysis,
                                            dailyCap: value,
                                        },
                                    }))
                                }
                            />
                            <NumericField
                                label="Monthly personal cap"
                                value={draft.autoAnalysis.monthlyCap}
                                placeholder="No personal cap"
                                onChange={(value) =>
                                    updateDraft((current) => ({
                                        ...current,
                                        autoAnalysis: {
                                            ...current.autoAnalysis,
                                            monthlyCap: value,
                                        },
                                    }))
                                }
                            />
                            <NumericField
                                label="Keep credits in reserve"
                                value={draft.autoAnalysis.reserveCredits}
                                placeholder="0"
                                onChange={(value) =>
                                    updateDraft((current) => ({
                                        ...current,
                                        autoAnalysis: {
                                            ...current.autoAnalysis,
                                            reserveCredits: value,
                                        },
                                    }))
                                }
                            />
                            <label className="space-y-1.5 text-sm">
                                <span className="font-medium">
                                    Apply policy to
                                </span>
                                <Select
                                    value={draft.autoAnalysis.backlogMode}
                                    onValueChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            autoAnalysis: {
                                                ...current.autoAnalysis,
                                                backlogMode:
                                                    value as BacklogMode,
                                            },
                                        }))
                                    }
                                >
                                    <SelectTrigger aria-label="Automatic analysis backlog policy">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="new">
                                            New games only
                                        </SelectItem>
                                        <SelectItem value="all">
                                            Include eligible games already in
                                            your library
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </label>
                        </div>

                        <details className="rounded-md border">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                Advanced eligibility
                                <ChevronDown
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            </summary>
                            <div className="border-t p-3">
                                <NumericField
                                    label="Minimum game length (plies)"
                                    value={draft.autoAnalysis.minPlies}
                                    placeholder="20"
                                    onChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            autoAnalysis: {
                                                ...current.autoAnalysis,
                                                minPlies: value,
                                            },
                                        }))
                                    }
                                />
                                <p className="mt-2 text-xs text-muted-foreground">
                                    Very short or aborted games can remain in
                                    your library without spending analysis
                                    credits.
                                </p>
                            </div>
                        </details>
                    </fieldset>

                    {capacity || billing ? (
                        <div className="rounded-md bg-muted/60 p-3 text-sm">
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                                <span>
                                    Balance:{' '}
                                    <strong>
                                        {capacity?.currentBalance ??
                                            billing?.currentBalance}
                                    </strong>
                                </span>
                                <span>
                                    Reservable now:{' '}
                                    <strong>
                                        {capacity?.reservableCredits ??
                                            billing?.reservableCredits}
                                    </strong>
                                </span>
                                <span>
                                    Plan monthly remaining:{' '}
                                    <strong>
                                        {capacity?.planMonthlyRemaining ??
                                            billing?.monthlyRemaining}
                                    </strong>
                                </span>
                                {capacity?.dailyRemaining != null ? (
                                    <span>
                                        Personal daily remaining:{' '}
                                        <strong>
                                            {capacity.dailyRemaining}
                                        </strong>
                                    </span>
                                ) : null}
                                {capacity?.monthlyRemaining != null ? (
                                    <span>
                                        Personal monthly remaining:{' '}
                                        <strong>
                                            {capacity.monthlyRemaining}
                                        </strong>
                                    </span>
                                ) : null}
                            </div>
                            {capacity?.blockingReason ||
                            billing?.limitingReason ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {humanizeAutomationBlockReason(
                                        capacity?.blockingReason
                                    ) ??
                                        billing?.limitingReason}
                                </p>
                            ) : null}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            Current plan limits are temporarily unavailable.
                            They will still be enforced by the server.
                        </p>
                    )}

                    {validationError ? (
                        <p className="text-sm text-destructive" role="alert">
                            {validationError}
                        </p>
                    ) : null}

                    <div
                        className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between"
                        aria-live="polite"
                    >
                        <div className="text-xs text-muted-foreground">
                            {dirty
                                ? 'You have unsaved automation changes.'
                                : 'Automation settings are up to date.'}
                        </div>
                        <div className="flex gap-2">
                            {dirty && saved ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    disabled={saving}
                                    onClick={() => setDraft(saved)}
                                >
                                    Discard
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                disabled={
                                    !dirty || !!validationError || saving
                                }
                                onClick={() => void save()}
                            >
                                {saving ? 'Saving…' : 'Save automation'}
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <ActionConfirmDialog
                open={enableConfirmOpen}
                onOpenChange={setEnableConfirmOpen}
                title="Enable automatic server analysis?"
                description="Matching games may spend server credits while Backranq is closed. Your personal caps, credit reserve and plan limits are always enforced. Importing games remains free."
                confirmLabel="Enable automatic analysis"
                onConfirm={() => {
                    updateDraft((current) => ({
                        ...current,
                        autoAnalysis: {
                            ...current.autoAnalysis,
                            enabled: true,
                        },
                    }));
                    setEnableConfirmOpen(false);
                }}
            >
                <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm">
                    <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                    <span>
                        Browser analysis is still free and is never enabled by
                        this setting.
                    </span>
                </div>
            </ActionConfirmDialog>
        </div>
    );
}

function NumericField({
    label,
    value,
    placeholder,
    onChange,
}: {
    label: string;
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
}) {
    return (
        <label className="space-y-1.5 text-sm">
            <span className="font-medium">{label}</span>
            <Input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}
