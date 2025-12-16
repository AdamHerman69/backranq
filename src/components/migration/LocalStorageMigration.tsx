'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    hasLocalMiniState,
    localPuzzleCount,
    migrateLocalStorageToDb,
} from '@/lib/migration/localStorageToDb';

type Props = {
    isLoggedIn: boolean;
    onMigrated?: () => void;
};

export function LocalStorageMigration({ isLoggedIn, onMigrated }: Props) {
    const [busy, setBusy] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    const show = useMemo(() => {
        if (!isLoggedIn) return false;
        if (dismissed) return false;
        return hasLocalMiniState();
    }, [dismissed, isLoggedIn]);

    const count = useMemo(() => (show ? localPuzzleCount() : 0), [show]);

    if (!show) return null;

    async function run() {
        setBusy(true);
        const id = toast.loading('Importing from this browser…');
        try {
            const res = await migrateLocalStorageToDb();
            toast.success(`Imported ${res.importedPuzzles} puzzles`, { id });
            setDismissed(true);
            onMigrated?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Import failed', { id });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            style={{
                border: '1px solid var(--border, #e6e6e6)',
                borderRadius: 12,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}
        >
            <div style={{ fontWeight: 650 }}>Sync from this browser</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
                We found local BackRank data in this browser
                {count ? ` (${count} puzzles)` : ''}. Import it into your account so it
                syncs across devices.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                    type="button"
                    onClick={run}
                    disabled={busy}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid transparent',
                        background: 'var(--text-primary, #000)',
                        color: 'var(--background, #fafafa)',
                        fontWeight: 650,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.7 : 1,
                    }}
                >
                    {busy ? 'Importing…' : `Import${count ? ` ${count}` : ''} puzzles`}
                </button>
                <button
                    type="button"
                    onClick={() => setDismissed(true)}
                    style={{
                        height: 36,
                        padding: '0 12px',
                        borderRadius: 10,
                        border: '1px solid var(--button-secondary-border, #ebebeb)',
                        background: 'transparent',
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >
                    Not now
                </button>
            </div>
        </div>
    );
}


