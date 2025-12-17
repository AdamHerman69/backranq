import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
    type PreferencesSchema,
} from '@/lib/preferences';

const NEW_KEY = 'backranq.miniState.v1';
const OLD_KEY = 'backrank.miniState.v1';

function readKey(key: string): PartialPreferences | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as PartialPreferences;
    } catch {
        return null;
    }
}

export function readLocalMiniState(): PartialPreferences | null {
    const next = readKey(NEW_KEY);
    if (next) return next;

    // Back-compat: migrate old key to new key.
    const old = readKey(OLD_KEY);
    if (old) {
        try {
            localStorage.setItem(NEW_KEY, JSON.stringify(old));
            localStorage.removeItem(OLD_KEY);
        } catch {
            // ignore
        }
    }
    return old;
}

export function hasLocalMiniState(): boolean {
    return !!readLocalMiniState();
}

export function localPuzzleCount(): number {
    const st = readLocalMiniState();
    return Array.isArray(st?.puzzles) ? st!.puzzles!.length : 0;
}

export async function fetchDbPreferences(): Promise<PreferencesSchema> {
    const res = await fetch('/api/user/preferences', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load preferences');
    const json = (await res.json().catch(() => ({}))) as {
        preferences?: PreferencesSchema;
    };
    const prefs = json.preferences;
    return prefs ?? defaultPreferences();
}

export async function saveDbPreferences(patch: PartialPreferences) {
    const res = await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? 'Failed to save preferences');
    }
}

export async function migrateLocalStorageToDb(): Promise<{
    importedPuzzles: number;
}> {
    const local = readLocalMiniState();
    if (!local) return { importedPuzzles: 0 };

    const db = await fetchDbPreferences();
    const merged = mergePreferences(db, local);
    await saveDbPreferences(merged);

    try {
        localStorage.removeItem(NEW_KEY);
        localStorage.removeItem(OLD_KEY);
    } catch {
        // ignore
    }

    return {
        importedPuzzles: Array.isArray(local.puzzles)
            ? local.puzzles.length
            : 0,
    };
}
