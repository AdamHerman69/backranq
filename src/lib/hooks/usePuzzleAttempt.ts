'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type QueuedAttempt = {
    id: string;
    puzzleId: string;
    userMoveUci: string;
    wasCorrect: boolean;
    timeSpentMs?: number;
    createdAt: number;
};

class AttemptSendError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'AttemptSendError';
        this.status = status;
    }
}

const NEW_STORAGE_KEY = 'backranq.puzzleAttemptQueue.v1';
const OLD_STORAGE_KEY = 'backrank.puzzleAttemptQueue.v1';

function readQueueFromKey(key: string): QueuedAttempt[] {
    try {
        const raw = localStorage.getItem(key);
        const json = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(json)) return [];
        return json.filter(
            (x) => x && typeof x === 'object'
        ) as QueuedAttempt[];
    } catch {
        return [];
    }
}

function readQueue(): QueuedAttempt[] {
    const next = readQueueFromKey(NEW_STORAGE_KEY);
    if (next.length > 0) return next;

    const old = readQueueFromKey(OLD_STORAGE_KEY);
    if (old.length > 0) {
        // Back-compat: migrate old queue to new key.
        try {
            localStorage.setItem(
                NEW_STORAGE_KEY,
                JSON.stringify(old.slice(-200))
            );
            localStorage.removeItem(OLD_STORAGE_KEY);
        } catch {
            // ignore
        }
    }
    return old;
}

function writeQueue(next: QueuedAttempt[]) {
    try {
        localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(next.slice(-200)));
        // Best-effort cleanup.
        localStorage.removeItem(OLD_STORAGE_KEY);
    } catch {
        // ignore
    }
}

function uid() {
    return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function sendAttempt(a: QueuedAttempt) {
    const res = await fetch(`/api/puzzles/${a.puzzleId}/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userMoveUci: a.userMoveUci,
            wasCorrect: a.wasCorrect,
            timeSpentMs: a.timeSpentMs,
        }),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok)
        throw new AttemptSendError(
            json?.error ?? 'Failed to record attempt',
            res.status
        );
    return json;
}

export function usePuzzleAttempt() {
    const startRef = useRef<number | null>(null);
    const inFlightRef = useRef<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [queued, setQueued] = useState(0);

    const flushQueue = useCallback(async () => {
        if (typeof window === 'undefined') return;
        const q = readQueue();
        if (q.length === 0) {
            setQueued(0);
            return;
        }
        // Avoid parallel flushes
        if (inFlightRef.current.has('__flush__')) return;
        inFlightRef.current.add('__flush__');
        setSaving(true);
        setLastError(null);
        try {
            // FIFO
            const remaining: QueuedAttempt[] = [];
            let stop = false;
            for (const item of q) {
                if (stop) {
                    remaining.push(item);
                    continue;
                }
                try {
                    await sendAttempt(item);
                } catch (e) {
                    const status =
                        e instanceof AttemptSendError ? e.status : undefined;

                    // Permanent failures: drop them so the queue can drain.
                    // - 404: puzzle no longer exists for this user (deleted/migrated)
                    // - 400: bad payload (old client data)
                    if (status === 404 || status === 400) {
                        continue;
                    }

                    // Auth failures: keep this and stop flushing to avoid spamming the server.
                    if (status === 401 || status === 403) {
                        remaining.push(item);
                        stop = true;
                        setLastError(
                            'Not signed in (or session expired). Attempts will sync after you log in again.'
                        );
                        continue;
                    }

                    // Transient failures (offline/5xx/etc): keep this and stop early to avoid log spam.
                    remaining.push(item);
                    stop = true;
                    setLastError(
                        e instanceof Error
                            ? e.message
                            : 'Failed to sync attempts'
                    );
                }
            }
            writeQueue(remaining);
            setQueued(remaining.length);
        } finally {
            inFlightRef.current.delete('__flush__');
            setSaving(false);
        }
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        setQueued(readQueue().length);
        const onOnline = () => flushQueue();
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [flushQueue]);

    const startAttempt = useCallback((puzzleId: string) => {
        if (!puzzleId) return;
        startRef.current = Date.now();
        setLastError(null);
    }, []);

    const recordAttempt = useCallback(
        async (args: { puzzleId: string; move: string; correct: boolean }) => {
            const puzzleId = args.puzzleId;
            if (!puzzleId) return { ok: false as const };
            if (inFlightRef.current.has(puzzleId))
                return { ok: false as const };
            inFlightRef.current.add(puzzleId);
            setSaving(true);
            setLastError(null);
            try {
                const startedAt = startRef.current ?? Date.now();
                const timeSpentMs = Math.max(0, Date.now() - startedAt);
                const payload: QueuedAttempt = {
                    id: uid(),
                    puzzleId,
                    userMoveUci: args.move,
                    wasCorrect: args.correct,
                    timeSpentMs,
                    createdAt: Date.now(),
                };

                try {
                    await sendAttempt(payload);
                    return { ok: true as const, queued: false as const };
                } catch (e) {
                    // Queue for later
                    const q = readQueue();
                    q.push(payload);
                    writeQueue(q);
                    setQueued(q.length);
                    setLastError(
                        e instanceof Error ? e.message : 'Attempt queued'
                    );
                    return { ok: true as const, queued: true as const };
                }
            } finally {
                inFlightRef.current.delete(puzzleId);
                setSaving(false);
            }
        },
        []
    );

    return {
        startAttempt,
        recordAttempt,
        flushQueue,
        saving,
        queued,
        lastError,
    };
}
