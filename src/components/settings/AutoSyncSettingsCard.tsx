'use client';

import * as React from 'react';
import { useSession } from 'next-auth/react';
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    Cloud,
    Copy,
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import {
    GAME_AUTOMATION_PROVIDER_KEYS,
    GAME_AUTOMATION_TIME_CONTROL_KEYS,
    type AutoAnalysisResultScope,
    type GameAutomationExistingGameScope,
    type GameAutomationMode,
    type GameAutomationProviderKey,
    type GameAutomationRules,
    type GameAutomationTimeControlKey,
    type PreferencesSchema,
} from '@/lib/preferences';
import {
    getSyncStatus,
    type SyncProviderState,
    type SyncStatus,
} from '@/lib/services/gameSync';

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
    paused: boolean;
    rules: GameAutomationRules;
    analysis: {
        resultScope: AutoAnalysisResultScope;
        ratedOnly: boolean;
        minPlies: string;
        dailyCap: string;
        monthlyCap: string;
        reserveCredits: string;
        existingGames: GameAutomationExistingGameScope;
    };
};

const PROVIDERS: Array<{
    key: GameAutomationProviderKey;
    label: string;
}> = [
    { key: 'lichess', label: 'Lichess' },
    { key: 'chesscom', label: 'Chess.com' },
];

const TIME_CONTROLS: Array<{
    key: GameAutomationTimeControlKey;
    label: string;
}> = [
    { key: 'bullet', label: 'Bullet' },
    { key: 'blitz', label: 'Blitz' },
    { key: 'rapid', label: 'Rapid' },
    { key: 'classical', label: 'Classical' },
    { key: 'unknown', label: 'Unknown' },
];

const AUTOMATION_MODES: Array<{
    value: GameAutomationMode;
    label: string;
}> = [
    { value: 'IGNORE', label: 'Ignore' },
    { value: 'IMPORT_ONLY', label: 'Import only' },
    { value: 'AUTO_ANALYZE', label: 'Import + analyze' },
];

function inputString(value: number | string | null | undefined) {
    return value == null ? '' : String(value);
}

export function automationDraftFromPreferences(
    preferences: PreferencesSchema
): AutomationDraft {
    const policy = preferences.gameAutomation;
    return {
        paused: policy.paused,
        rules: {
            lichess: { ...policy.rules.lichess },
            chesscom: { ...policy.rules.chesscom },
        },
        analysis: {
            resultScope: policy.analysis.resultScope,
            ratedOnly: policy.analysis.ratedOnly,
            minPlies: inputString(policy.analysis.minPlies),
            dailyCap: inputString(policy.analysis.dailyCap),
            monthlyCap: inputString(policy.analysis.monthlyCap),
            reserveCredits: inputString(policy.analysis.reserveCredits),
            existingGames: policy.analysis.existingGames,
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
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        return undefined;
    }
    return number;
}

function hasAutomaticAnalysis(draft: AutomationDraft) {
    return GAME_AUTOMATION_PROVIDER_KEYS.some((provider) =>
        GAME_AUTOMATION_TIME_CONTROL_KEYS.some(
            (timeControl) =>
                draft.rules[provider][timeControl] === 'AUTO_ANALYZE'
        )
    );
}

export function validateAutomationDraft(draft: AutomationDraft): string | null {
    if (optionalInteger(draft.analysis.minPlies, 0, 1_000) == null) {
        return 'Minimum game length must be a whole number from 0 to 1,000 plies.';
    }
    if (optionalInteger(draft.analysis.dailyCap, 1, 10_000) === undefined) {
        return 'Daily personal cap must be a positive whole number or blank.';
    }
    if (
        optionalInteger(draft.analysis.monthlyCap, 1, 100_000) === undefined
    ) {
        return 'Monthly personal cap must be a positive whole number or blank.';
    }
    if (optionalInteger(draft.analysis.reserveCredits, 0, 100_000) == null) {
        return 'Credit reserve must be a whole number of zero or more.';
    }
    const daily = optionalInteger(draft.analysis.dailyCap, 1, 10_000);
    const monthly = optionalInteger(draft.analysis.monthlyCap, 1, 100_000);
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
        gameAutomation: {
            paused: draft.paused,
            rules: draft.rules,
            analysis: {
                resultScope: draft.analysis.resultScope,
                ratedOnly: draft.analysis.ratedOnly,
                minPlies: optionalInteger(
                    draft.analysis.minPlies,
                    0,
                    1_000
                ) as number,
                dailyCap: optionalInteger(
                    draft.analysis.dailyCap,
                    1,
                    10_000
                ),
                monthlyCap: optionalInteger(
                    draft.analysis.monthlyCap,
                    1,
                    100_000
                ),
                reserveCredits: optionalInteger(
                    draft.analysis.reserveCredits,
                    0,
                    100_000
                ) as number,
                existingGames: draft.analysis.existingGames,
            },
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
        <div className="min-w-0 space-y-1 rounded-md bg-muted/40 p-3">
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
            {username ? (
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
                    {username === undefined
                        ? 'Connection status could not be loaded.'
                        : 'You can set the rules now and connect this account later.'}
                </p>
            )}
        </div>
    );
}

export function GameAutomationSettingsCard({
    ownerId: serverOwnerId,
}: {
    ownerId: string;
}) {
    const { data: session, status: sessionStatus } = useSession();
    const activeOwnerId =
        sessionStatus === 'authenticated' ? session?.user?.id ?? null : null;
    const ownerEpochRef = React.useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        activeOwnerId
    );
    const ownerReady =
        sessionStatus === 'authenticated' && activeOwnerId === serverOwnerId;
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<AutomationSyncStatus | null>(null);
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
        try {
            const response = await fetch('/api/user/preferences', {
                cache: 'no-store',
            });
            const body = (await response.json().catch(() => ({}))) as {
                ownerId?: string;
                preferences?: PreferencesSchema;
                error?: string;
            };
            if (!response.ok || !body.preferences || body.ownerId !== run.ownerId) {
                throw new Error(
                    body.ownerId && body.ownerId !== run.ownerId
                        ? 'The server returned settings for a different account. Reload Settings.'
                        : body.error ?? 'Could not load automation preferences'
                );
            }
            if (requestId !== requestIdRef.current || !runIsCurrent(run)) return;
            const next = automationDraftFromPreferences(body.preferences);
            setDraft(next);
            setSaved(next);
        } catch (error) {
            if (requestId !== requestIdRef.current || !runIsCurrent(run)) return;
            setDraft(null);
            setSaved(null);
            setLoadError(
                error instanceof Error
                    ? error.message
                    : 'Could not load automation preferences'
            );
        } finally {
            if (requestId === requestIdRef.current && runIsCurrent(run)) {
                setLoading(false);
            }
        }
    }, [runIsCurrent]);

    const refreshConnectionStatus = React.useCallback(async () => {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) return;
        const requestId = ++statusRequestIdRef.current;
        try {
            const next = (await getSyncStatus()) as AutomationSyncStatus;
            if (requestId !== statusRequestIdRef.current || !runIsCurrent(run)) {
                return;
            }
            if (next.ownerId !== run.ownerId) {
                setStatus(null);
                setLoadError(
                    'The server returned source status for a different account. Reload Settings.'
                );
                return;
            }
            setStatus(next);
        } catch {
            if (requestId === statusRequestIdRef.current && runIsCurrent(run)) {
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
            window.removeEventListener(CHESS_CONNECTIONS_CHANGED_EVENT, reload);
        };
    }, [load, ownerReady, refreshConnectionStatus, sessionStatus]);

    function updateDraft(
        updater: (current: AutomationDraft) => AutomationDraft
    ) {
        setDraft((current) => (current ? updater(current) : current));
    }

    const validationError = draft ? validateAutomationDraft(draft) : null;
    const dirty =
        !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

    async function persistSave() {
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
        const toastId = toast.loading('Saving game automation…');
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
            if (!response.ok) throw new Error(body.error ?? 'Save failed');
            if (body.ownerId !== run.ownerId || !body.preferences) {
                throw new Error(
                    'The server could not confirm which account was updated. Reload Settings.'
                );
            }
            if (requestId !== saveRequestIdRef.current || !runIsCurrent(run)) {
                toast.dismiss(toastId);
                return;
            }
            const next = automationDraftFromPreferences(body.preferences);
            setDraft(next);
            setSaved(next);
            toast.success('Game automation saved.', { id: toastId });
            await refreshConnectionStatus();
        } catch (error) {
            if (requestId !== saveRequestIdRef.current || !runIsCurrent(run)) {
                toast.dismiss(toastId);
                return;
            }
            toast.error(error instanceof Error ? error.message : 'Save failed', {
                id: toastId,
            });
        } finally {
            if (requestId === saveRequestIdRef.current && runIsCurrent(run)) {
                setSaving(false);
            }
        }
    }

    function requestSave() {
        if (
            draft &&
            saved &&
            hasAutomaticAnalysis(draft) &&
            !hasAutomaticAnalysis(saved)
        ) {
            setEnableConfirmOpen(true);
            return;
        }
        void persistSave();
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
                                {loadError ?? 'Your saved settings were not changed.'}
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
    const syncStates = status?.gameAutomation?.states;
    const capacity = status?.automation?.capacity;
    const billing = status?.billing;
    const analysisEnabled = hasAutomaticAnalysis(draft);

    return (
        <>
            <Card id="game-automation" className="scroll-mt-24">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Cloud className="h-4 w-4" aria-hidden="true" />
                        Game automation
                    </CardTitle>
                    <CardDescription>
                        Choose one action for every source and time control.
                        Ignored games are not imported; Import + analyze creates
                        training positions automatically.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <label className="flex items-start justify-between gap-4 rounded-md border p-3 text-sm">
                        <span className="min-w-0">
                            <span className="block font-medium">
                                Pause all game automation
                            </span>
                            <span className="block text-muted-foreground">
                                Keeps your rules intact while stopping scheduled
                                imports and new automatic analyses.
                            </span>
                        </span>
                        <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 accent-foreground"
                            checked={draft.paused}
                            disabled={saving}
                            onChange={(event) =>
                                updateDraft((current) => ({
                                    ...current,
                                    paused: event.target.checked,
                                }))
                            }
                        />
                    </label>

                    <div className="grid gap-4 lg:grid-cols-2">
                        {PROVIDERS.map(({ key: provider, label }) => {
                            const username =
                                status === null
                                    ? undefined
                                    : provider === 'lichess'
                                      ? linked?.lichessUsername ?? null
                                      : linked?.chesscomUsername ?? null;
                            return (
                                <section
                                    key={provider}
                                    className="space-y-3 rounded-lg border p-3"
                                    aria-labelledby={`${provider}-automation-title`}
                                >
                                    <ProviderStatus
                                        label={label}
                                        username={username}
                                        state={syncStates?.[provider]}
                                    />
                                    <div className="flex items-center justify-between gap-2">
                                        <h3
                                            id={`${provider}-automation-title`}
                                            className="text-sm font-medium"
                                        >
                                            Rules by time control
                                        </h3>
                                        {provider === 'chesscom' ? (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                disabled={saving}
                                                onClick={() =>
                                                    updateDraft((current) => ({
                                                        ...current,
                                                        rules: {
                                                            ...current.rules,
                                                            chesscom: {
                                                                ...current.rules.lichess,
                                                            },
                                                        },
                                                    }))
                                                }
                                            >
                                                <Copy
                                                    className="mr-1.5 h-3.5 w-3.5"
                                                    aria-hidden="true"
                                                />
                                                Same as Lichess
                                            </Button>
                                        ) : null}
                                    </div>
                                    <div className="divide-y rounded-md border">
                                        {TIME_CONTROLS.map(
                                            ({ key: timeControl, label: timeLabel }) => (
                                                <div
                                                    key={timeControl}
                                                    className="flex items-center justify-between gap-3 p-2.5"
                                                >
                                                    <span className="text-sm">
                                                        {timeLabel}
                                                    </span>
                                                    <Select
                                                        value={
                                                            draft.rules[provider][
                                                                timeControl
                                                            ]
                                                        }
                                                        disabled={saving}
                                                        onValueChange={(value) =>
                                                            updateDraft((current) => ({
                                                                ...current,
                                                                rules: {
                                                                    ...current.rules,
                                                                    [provider]: {
                                                                        ...current.rules[
                                                                            provider
                                                                        ],
                                                                        [timeControl]:
                                                                            value as GameAutomationMode,
                                                                    },
                                                                },
                                                            }))
                                                        }
                                                    >
                                                        <SelectTrigger
                                                            className="w-36 sm:w-[10.5rem]"
                                                            aria-label={`${label} ${timeLabel} automation`}
                                                        >
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {AUTOMATION_MODES.map(
                                                                (mode) => (
                                                                    <SelectItem
                                                                        key={mode.value}
                                                                        value={mode.value}
                                                                    >
                                                                        {mode.label}
                                                                    </SelectItem>
                                                                )
                                                            )}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            )
                                        )}
                                    </div>
                                </section>
                            );
                        })}
                    </div>

                    {analysisEnabled ? (
                        <section className="space-y-4 rounded-lg border p-3">
                            <div>
                                <h3 className="flex items-center gap-2 text-sm font-medium">
                                    <Cpu className="h-4 w-4" aria-hidden="true" />
                                    Automatic analysis limits
                                </h3>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    These limits apply only to rows set to Import
                                    + analyze. Import-only games never spend credits.
                                </p>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className="space-y-1.5 text-sm">
                                    <span className="font-medium">Results</span>
                                    <Select
                                        value={draft.analysis.resultScope}
                                        disabled={saving}
                                        onValueChange={(value) =>
                                            updateDraft((current) => ({
                                                ...current,
                                                analysis: {
                                                    ...current.analysis,
                                                    resultScope:
                                                        value as AutoAnalysisResultScope,
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
                                        checked={draft.analysis.ratedOnly}
                                        disabled={saving}
                                        onChange={(event) =>
                                            updateDraft((current) => ({
                                                ...current,
                                                analysis: {
                                                    ...current.analysis,
                                                    ratedOnly: event.target.checked,
                                                },
                                            }))
                                        }
                                    />
                                </label>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                <NumericField
                                    label="Daily personal cap"
                                    value={draft.analysis.dailyCap}
                                    placeholder="No personal cap"
                                    disabled={saving}
                                    onChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            analysis: {
                                                ...current.analysis,
                                                dailyCap: value,
                                            },
                                        }))
                                    }
                                />
                                <NumericField
                                    label="Monthly personal cap"
                                    value={draft.analysis.monthlyCap}
                                    placeholder="No personal cap"
                                    disabled={saving}
                                    onChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            analysis: {
                                                ...current.analysis,
                                                monthlyCap: value,
                                            },
                                        }))
                                    }
                                />
                                <NumericField
                                    label="Keep credits in reserve"
                                    value={draft.analysis.reserveCredits}
                                    placeholder="0"
                                    disabled={saving}
                                    onChange={(value) =>
                                        updateDraft((current) => ({
                                            ...current,
                                            analysis: {
                                                ...current.analysis,
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
                                        value={draft.analysis.existingGames}
                                        disabled={saving}
                                        onValueChange={(value) =>
                                            updateDraft((current) => ({
                                                ...current,
                                                analysis: {
                                                    ...current.analysis,
                                                    existingGames:
                                                        value as GameAutomationExistingGameScope,
                                                },
                                            }))
                                        }
                                    >
                                        <SelectTrigger aria-label="Automatic analysis existing games policy">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="new">
                                                New games only
                                            </SelectItem>
                                            <SelectItem value="all">
                                                Include eligible games already imported
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
                                        value={draft.analysis.minPlies}
                                        placeholder="20"
                                        disabled={saving}
                                        onChange={(value) =>
                                            updateDraft((current) => ({
                                                ...current,
                                                analysis: {
                                                    ...current.analysis,
                                                    minPlies: value,
                                                },
                                            }))
                                        }
                                    />
                                    <p className="mt-2 text-xs text-muted-foreground">
                                        Very short or aborted games stay in your
                                        library without spending analysis credits.
                                    </p>
                                </div>
                            </details>
                        </section>
                    ) : (
                        <div className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                            No row is set to Import + analyze, so automatic
                            server analysis is off and cannot spend credits.
                        </div>
                    )}

                    {analysisEnabled && (capacity || billing) ? (
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
                            </div>
                            {capacity?.blockingReason || billing?.limitingReason ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {humanizeAutomationBlockReason(
                                        capacity?.blockingReason
                                    ) ?? billing?.limitingReason}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

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
                                disabled={!dirty || !!validationError || saving}
                                onClick={requestSave}
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
                description="Rows set to Import + analyze may spend server credits while Backranq is closed. Personal caps, your credit reserve and plan limits are always enforced."
                confirmLabel="Save and enable analysis"
                onConfirm={() => {
                    setEnableConfirmOpen(false);
                    void persistSave();
                }}
            >
                <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm">
                    <CheckCircle2
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                    />
                    <span>
                        Import-only games remain free and browser analysis is
                        never enabled by this setting.
                    </span>
                </div>
            </ActionConfirmDialog>
        </>
    );
}

function NumericField({
    label,
    value,
    placeholder,
    disabled,
    onChange,
}: {
    label: string;
    value: string;
    placeholder: string;
    disabled?: boolean;
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
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}
