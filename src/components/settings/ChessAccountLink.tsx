'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, Unplug } from 'lucide-react';

import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { InlineStatus } from '@/components/ui/async-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/ui/loading-button';
import { cn } from '@/lib/utils';

export type ChessProvider = 'lichess' | 'chesscom';
type Status = 'idle' | 'checking' | 'valid' | 'invalid' | 'error';

type Props = {
    provider: ChessProvider;
    currentUsername?: string | null;
    onUpdate: (username: string) => Promise<void>;
    onSync?: () => Promise<void>;
    disabled?: boolean;
};

function labelFor(provider: ChessProvider) {
    return provider === 'lichess' ? 'Lichess' : 'Chess.com';
}

function statusBadgeClass(status: Status, isLinked: boolean) {
    if (status === 'checking') return 'bg-info/10 text-info';
    if (status === 'valid') return 'bg-success/10 text-success';
    if (status === 'invalid') return 'bg-destructive/10 text-destructive';
    if (status === 'error') return 'bg-warning/10 text-warning';
    if (isLinked) return 'bg-success/10 text-success';
    return 'bg-surface-inset text-muted-foreground';
}

export function ChessAccountLink({
    provider,
    currentUsername,
    onUpdate,
    onSync,
    disabled = false,
}: Props) {
    const [username, setUsername] = useState(currentUsername ?? '');
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState<string>('');
    const [saving, setSaving] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [unlinkOpen, setUnlinkOpen] = useState(false);
    const validationRef = useRef<{
        requestId: number;
        controller: AbortController | null;
        timeoutId: number | null;
    }>({
        requestId: 0,
        controller: null,
        timeoutId: null,
    });

    const normalizedUsername = useMemo(() => {
        const v = username.trim();
        return provider === 'chesscom' ? v.toLowerCase() : v;
    }, [provider, username]);
    const currentNormalized = useMemo(() => {
        const value = (currentUsername ?? '').trim();
        return provider === 'chesscom' ? value.toLowerCase() : value;
    }, [currentUsername, provider]);

    useEffect(() => {
        validationRef.current.requestId += 1;
        validationRef.current.controller?.abort();
        if (validationRef.current.timeoutId !== null) {
            window.clearTimeout(validationRef.current.timeoutId);
        }
        validationRef.current.controller = null;
        validationRef.current.timeoutId = null;
        setUsername(currentUsername ?? '');
        setStatus('idle');
        setMessage('');
        setSaving(false);
        setSyncing(false);
        setUnlinkOpen(false);
    }, [currentUsername, disabled]);

    useEffect(
        () => () => {
            validationRef.current.requestId += 1;
            validationRef.current.controller?.abort();
            if (validationRef.current.timeoutId !== null) {
                window.clearTimeout(validationRef.current.timeoutId);
            }
            validationRef.current.controller = null;
            validationRef.current.timeoutId = null;
        },
        []
    );

    function invalidateValidation() {
        validationRef.current.requestId += 1;
        validationRef.current.controller?.abort();
        if (validationRef.current.timeoutId !== null) {
            window.clearTimeout(validationRef.current.timeoutId);
        }
        validationRef.current.controller = null;
        validationRef.current.timeoutId = null;
    }

    async function validate() {
        if (disabled) return false;
        invalidateValidation();
        const requestId = validationRef.current.requestId;
        const controller = new AbortController();
        validationRef.current.controller = controller;
        let timedOut = false;
        validationRef.current.timeoutId = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 10_000);
        const candidate = normalizedUsername;
        setStatus('checking');
        setMessage('');
        try {
            const url = new URL('/api/user/validate', window.location.origin);
            url.searchParams.set('provider', provider);
            url.searchParams.set('username', candidate);
            const res = await fetch(url.toString(), {
                cache: 'no-store',
                signal: controller.signal,
            });
            const json = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                exists?: boolean;
                error?: string;
            };
            if (
                controller.signal.aborted ||
                requestId !== validationRef.current.requestId
            ) {
                return false;
            }
            if (!res.ok || json.ok === false) {
                setStatus('error');
                setMessage(json.error ?? 'Validation failed');
                return false;
            }
            if (json.exists) {
                setStatus('valid');
                setMessage('Username found');
                return true;
            }
            setStatus('invalid');
            setMessage('Username not found');
            return false;
        } catch (e) {
            if (
                timedOut &&
                requestId === validationRef.current.requestId
            ) {
                setStatus('error');
                setMessage(
                    `${title} validation timed out. Try again.`
                );
                return false;
            }
            if (
                controller.signal.aborted ||
                requestId !== validationRef.current.requestId ||
                (e instanceof Error && e.name === 'AbortError')
            ) {
                return false;
            }
            setStatus('error');
            setMessage(e instanceof Error ? e.message : 'Unknown error');
            return false;
        } finally {
            if (
                requestId === validationRef.current.requestId &&
                validationRef.current.controller === controller
            ) {
                if (validationRef.current.timeoutId !== null) {
                    window.clearTimeout(validationRef.current.timeoutId);
                }
                validationRef.current.controller = null;
                validationRef.current.timeoutId = null;
            }
        }
    }

    async function save() {
        if (disabled) return;
        invalidateValidation();
        setSaving(true);
        try {
            await onUpdate(normalizedUsername);
            setMessage(
                currentNormalized
                    ? `Linked profile replaced. The next sync will start from ${normalizedUsername}.`
                    : `Account linked. Checking ${title} for games in the background.`
            );
        } catch {
            // The parent reports the provider-specific save error.
        } finally {
            setSaving(false);
        }
    }

    async function unlink() {
        if (disabled) return;
        invalidateValidation();
        setSaving(true);
        try {
            await onUpdate('');
            setUsername('');
            setStatus('idle');
            setMessage(
                `${title} disconnected. Imported games remain in your library.`
            );
            setUnlinkOpen(false);
        } catch {
            // The parent reports the provider-specific save error.
        } finally {
            setSaving(false);
        }
    }

    async function sync() {
        if (!onSync || disabled || saving || syncing || !currentUsername) return;
        setSyncing(true);
        try {
            await onSync();
        } finally {
            setSyncing(false);
        }
    }

    const title = labelFor(provider);
    const statusText =
        status === 'checking'
            ? 'Checking…'
            : status === 'valid'
              ? 'Valid'
              : status === 'invalid'
                ? 'Invalid'
                : status === 'error'
                  ? 'Error'
                  : currentUsername
                    ? 'Linked'
                    : 'Not linked';

    return (
        <div className="space-y-3 rounded-lg border border-border/80 bg-card p-3 shadow-control sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface-inset font-mono text-xs font-semibold text-primary">
                        {provider === 'lichess' ? 'Li' : 'C.'}
                    </span>
                    <div>
                        <div className="text-sm font-semibold">{title}</div>
                        <div className="text-xs text-muted-foreground">
                            {currentUsername ? `@${currentUsername}` : 'Public profile'}
                        </div>
                    </div>
                </div>
                <Badge
                    className={cn(
                        'gap-1.5 border-transparent',
                        statusBadgeClass(status, !!currentUsername)
                    )}
                >
                    {currentUsername && status === 'idle' ? (
                        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                    ) : null}
                    {statusText}
                </Badge>
            </div>

            <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                    {title} username
                </span>
                <Input
                    value={username}
                    aria-label={`${title} username`}
                    disabled={disabled || saving || syncing}
                    onChange={(e) => {
                        invalidateValidation();
                        setUsername(e.target.value);
                        setStatus('idle');
                        setMessage('');
                    }}
                    placeholder={`${title} username`}
                />
            </label>

            <div className="flex flex-wrap gap-2">
                <LoadingButton
                    type="button"
                    variant="outline"
                    loading={status === 'checking'}
                    loadingLabel="Checking…"
                    onClick={validate}
                    disabled={
                        saving ||
                        syncing ||
                        disabled ||
                        !normalizedUsername
                    }
                >
                    Validate
                </LoadingButton>
                <LoadingButton
                    type="button"
                    loading={saving}
                    loadingLabel={currentUsername ? 'Replacing…' : 'Linking…'}
                    onClick={save}
                    disabled={
                        syncing ||
                        disabled ||
                        !normalizedUsername ||
                        normalizedUsername === currentNormalized
                    }
                >
                    {currentUsername ? 'Replace' : 'Link account'}
                </LoadingButton>
                {currentUsername && onSync ? (
                    <LoadingButton
                        type="button"
                        variant="quiet"
                        loading={syncing}
                        loadingLabel="Syncing…"
                        onClick={() => void sync()}
                        disabled={disabled || saving}
                    >
                        <RefreshCw aria-hidden="true" />
                        Sync now
                    </LoadingButton>
                ) : null}
                {currentUsername ? (
                    <Button
                        type="button"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setUnlinkOpen(true)}
                        disabled={disabled || saving || syncing}
                    >
                        <Unplug aria-hidden="true" />
                        Disconnect
                    </Button>
                ) : null}
            </div>

            {message ? (
                <InlineStatus
                    tone={
                        status === 'invalid'
                            ? 'danger'
                            : status === 'error'
                              ? 'warning'
                              : status === 'valid'
                                ? 'success'
                                : 'neutral'
                    }
                    className="min-h-0 py-2 text-xs"
                    live
                >
                    {message}
                </InlineStatus>
            ) : null}

            <ActionConfirmDialog
                open={unlinkOpen}
                onOpenChange={setUnlinkOpen}
                title={`Disconnect ${title}?`}
                description={`Future ${title} sync will stop. Games already imported from this account stay in your library and can be deleted separately.`}
                confirmLabel={`Disconnect ${title}`}
                variant="destructive"
                busy={saving}
                onConfirm={unlink}
            />
        </div>
    );
}
