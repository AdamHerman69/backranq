'use client';

import { useMemo, useState } from 'react';

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

export function ChessAccountLink({ provider, currentUsername, onUpdate }: Props) {
    const [username, setUsername] = useState(currentUsername ?? '');
    const [status, setStatus] = useState<Status>('idle');
    const [message, setMessage] = useState<string>('');
    const [saving, setSaving] = useState(false);

    const normalizedUsername = useMemo(() => {
        const v = username.trim();
        return provider === 'chesscom' ? v.toLowerCase() : v;
    }, [provider, username]);

    async function validate() {
        setStatus('checking');
        setMessage('');
        try {
            const url = new URL('/api/user/validate', window.location.origin);
            url.searchParams.set('provider', provider);
            url.searchParams.set('username', normalizedUsername);
            const res = await fetch(url.toString(), { cache: 'no-store' });
            const json = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                exists?: boolean;
                error?: string;
            };
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
            setStatus('error');
            setMessage(e instanceof Error ? e.message : 'Unknown error');
            return false;
        }
    }

    async function save() {
        setSaving(true);
        try {
            await onUpdate(normalizedUsername);
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
                    onChange={(e) => {
                        setUsername(e.target.value);
                        setStatus('idle');
                        setMessage('');
                    }}
                    placeholder={`${title} username`}
                    className="sm:max-w-sm"
                />
                <div className="flex gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={validate}
                        disabled={status === 'checking' || !normalizedUsername}
                    >
                        Validate
                    </Button>
                    <Button
                        type="button"
                        onClick={save}
                        disabled={saving || !normalizedUsername}
                    >
                        Save
                    </Button>
                </div>
            </div>

            {message ? (
                <div className="text-sm text-muted-foreground">{message}</div>
            ) : null}
        </div>
    );
}


