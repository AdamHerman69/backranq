'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type ChessProvider = 'lichess' | 'chesscom';
type Status = 'idle' | 'checking' | 'valid' | 'invalid' | 'error';

type Props = {
    provider: ChessProvider;
    currentUsername?: string | null;
    onUpdate: (username: string) => Promise<void>;
    disabled?: boolean;
};

function labelFor(provider: ChessProvider) {
    return provider === 'lichess' ? 'Lichess' : 'Chess.com';
}

function statusBadgeClass(status: Status, isLinked: boolean) {
    if (status === 'checking') return 'bg-muted text-muted-foreground';
    if (status === 'valid') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    if (status === 'invalid') return 'bg-red-500/15 text-red-700 dark:text-red-300';
    if (status === 'error') return 'bg-amber-500/20 text-amber-700 dark:text-amber-300';
    if (isLinked) return 'bg-violet-500/15 text-violet-700 dark:text-violet-300';
    return 'bg-muted text-muted-foreground';
}

export function ChessAccountLink({
    provider,
    currentUsername,
    onUpdate,
    disabled = false,
}: Props) {
    const [username, setUsername] = useState(currentUsername ?? '');
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState<string>('');
    const [saving, setSaving] = useState(false);
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
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{title}</div>
                <Badge
                    className={cn(
                        'border-transparent',
                        statusBadgeClass(status, !!currentUsername)
                    )}
                >
                    {statusText}
                </Badge>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                    value={username}
                    aria-label={`${title} username`}
                    disabled={disabled || saving}
                    onChange={(e) => {
                        invalidateValidation();
                        setUsername(e.target.value);
                        setStatus('idle');
                        setMessage('');
                    }}
                    placeholder={`${title} username`}
                    className="sm:max-w-sm"
                />
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={validate}
                        disabled={
                            saving ||
                            disabled ||
                            status === 'checking' ||
                            !normalizedUsername
                        }
                    >
                        Validate
                    </Button>
                    <Button
                        type="button"
                        onClick={save}
                        disabled={
                            saving ||
                            disabled ||
                            !normalizedUsername ||
                            normalizedUsername === currentNormalized
                        }
                    >
                        {currentUsername ? 'Replace' : 'Link account'}
                    </Button>
                    {currentUsername ? (
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setUnlinkOpen(true)}
                            disabled={disabled || saving}
                        >
                            Disconnect
                        </Button>
                    ) : null}
                </div>
            </div>

            {message ? (
                <div
                    className="text-sm text-muted-foreground"
                    role="status"
                    aria-live="polite"
                >
                    {message}
                </div>
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
