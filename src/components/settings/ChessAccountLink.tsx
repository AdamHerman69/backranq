'use client';

import { useMemo, useState } from 'react';

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ minWidth: 84, fontWeight: 650 }}>{title}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>{statusText}</div>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input
                    value={username}
                    onChange={(e) => {
                        setUsername(e.target.value);
                        setStatus('idle');
                        setMessage('');
                    }}
                    placeholder={`${title} username`}
                    style={{
                        height: 36,
                        padding: '0 10px',
                        borderRadius: 10,
                        border: '1px solid var(--border, #e6e6e6)',
                        minWidth: 240,
                    }}
                />
                <button
                    type="button"
                    onClick={validate}
                    disabled={status === 'checking'}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid var(--button-secondary-border, #ebebeb)',
                        background: 'transparent',
                        fontWeight: 600,
                        cursor: status === 'checking' ? 'not-allowed' : 'pointer',
                    }}
                >
                    Validate
                </button>
                <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid transparent',
                        background: 'var(--text-primary, #000)',
                        color: 'var(--background, #fafafa)',
                        fontWeight: 650,
                        cursor: saving ? 'not-allowed' : 'pointer',
                        opacity: saving ? 0.7 : 1,
                    }}
                >
                    Save
                </button>
            </div>

            {message ? (
                <div style={{ fontSize: 12, opacity: 0.8 }}>{message}</div>
            ) : null}
        </div>
    );
}


