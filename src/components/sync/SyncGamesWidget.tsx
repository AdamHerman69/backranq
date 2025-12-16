'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { SyncGamesModal } from '@/components/sync/SyncGamesModal';
import { getSyncStatus } from '@/lib/services/gameSync';

export function SyncGamesWidget({
    context,
    enableAnalyze = true,
    variant = 'button',
}: {
    context: 'home' | 'games';
    enableAnalyze?: boolean;
    variant?: 'button' | 'banner';
}) {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<{
        linked: { lichessUsername: string | null; chesscomUsername: string | null };
        lastSync: { lichess: string | null; chesscom: string | null };
    } | null>(null);

    useEffect(() => {
        getSyncStatus().then(setStatus).catch(() => {});
    }, []);

    const hasLinked = useMemo(() => {
        return !!status?.linked.lichessUsername || !!status?.linked.chesscomUsername;
    }, [status]);

    if (!hasLinked) {
        return (
            <div style={{ fontSize: 12, opacity: 0.8 }}>
                Link your Lichess/Chess.com usernames in <Link href="/settings">Settings</Link> to sync games.
            </div>
        );
    }

    return (
        <>
            {variant === 'banner' ? (
                <div
                    style={{
                        border: '1px solid var(--border, #e6e6e6)',
                        borderRadius: 12,
                        padding: 12,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 10,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                    }}
                >
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Sync games from your linked accounts into BackRank.
                    </div>
                    <button
                        type="button"
                        onClick={() => setOpen(true)}
                        style={{
                            height: 36,
                            padding: '0 12px',
                            borderRadius: 10,
                            border: '1px solid transparent',
                            background: 'var(--text-primary, #000)',
                            color: 'var(--background, #fafafa)',
                            fontWeight: 750,
                            cursor: 'pointer',
                        }}
                    >
                        Sync games
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid var(--border, #e6e6e6)',
                        background: 'transparent',
                        fontWeight: 750,
                        cursor: 'pointer',
                    }}
                >
                    Sync games
                </button>
            )}

            <SyncGamesModal
                open={open}
                onClose={() => setOpen(false)}
                context={context}
                enableAnalyze={enableAnalyze}
                onFinished={() => {
                    // best-effort refresh without assuming router here
                    window.location.reload();
                }}
            />
        </>
    );
}


