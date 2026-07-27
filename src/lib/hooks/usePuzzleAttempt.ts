'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    isCurrentPuzzleAttemptFlushRun,
    directSaveAfterQueueWriteFailure,
    puzzleAttemptQueueStorageKey,
    tryWritePuzzleAttemptQueue,
    type PuzzleAttemptFlushRun,
} from '@/lib/puzzles/attemptQueue';
import {
    MAX_PUZZLE_ATTEMPT_TIME_MS,
    type PuzzleNonMoveOutcome,
} from '@/lib/puzzles/attemptOutcomes';

type QueuedAttempt = {
    clientAttemptId: string;
    puzzleId: string;
    userMoveUci?: string;
    outcome?: PuzzleNonMoveOutcome;
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

// v1 was not user-scoped. It is intentionally never read or migrated because
// its owner cannot be established safely after an auth transition.

function readQueue(key: string): QueuedAttempt[] {
    try {
        const raw = localStorage.getItem(key);
        const json = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(json)) return [];
        return json.filter((item): item is QueuedAttempt => {
            if (!item || typeof item !== 'object') return false;
            const value = item as Record<string, unknown>;
            return (
                typeof value.clientAttemptId === 'string' &&
                typeof value.puzzleId === 'string' &&
                ((typeof value.userMoveUci === 'string' &&
                    value.outcome === undefined) ||
                    (value.userMoveUci === undefined &&
                        (value.outcome === 'revealed' ||
                            value.outcome === 'skipped'))) &&
                typeof value.wasCorrect === 'boolean' &&
                typeof value.createdAt === 'number'
            );
        });
    } catch {
        return [];
    }
}

function writeQueue(key: string, next: QueuedAttempt[]) {
    return tryWritePuzzleAttemptQueue(
        localStorage,
        key,
        JSON.stringify(next.slice(-200))
    );
}

function enqueue(key: string, attempt: QueuedAttempt) {
    const current = readQueue(key);
    if (!current.some((item) => item.clientAttemptId === attempt.clientAttemptId)) {
        current.push(attempt);
    }
    return { ok: writeQueue(key, current), count: current.length };
}

function removeQueuedAttempt(key: string, clientAttemptId: string) {
    const current = readQueue(key);
    const next = current.filter(
        (item) => item.clientAttemptId !== clientAttemptId
    );
    return { ok: writeQueue(key, next), count: next.length };
}

function createClientAttemptId() {
    return crypto.randomUUID();
}

function errorMessageFromJson(json: unknown, fallback: string) {
    if (
        json &&
        typeof json === 'object' &&
        'error' in json &&
        typeof json.error === 'string'
    ) {
        return json.error;
    }
    return fallback;
}

async function sendAttempt(a: QueuedAttempt, signal: AbortSignal) {
    const response = await fetch(`/api/puzzles/${a.puzzleId}/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
            clientAttemptId: a.clientAttemptId,
            userMoveUci: a.userMoveUci,
            outcome: a.outcome,
            wasCorrect: a.wasCorrect,
            timeSpentMs: a.timeSpentMs,
        }),
    });
    const json = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
        throw new AttemptSendError(
            errorMessageFromJson(json, 'Failed to record attempt'),
            response.status
        );
    }
    return json;
}

export function usePuzzleAttempt() {
    const { data: session, status: sessionStatus } = useSession();
    const userId = session?.user?.id ?? null;
    const startRef = useRef<number | null>(null);
    const activeUserRef = useRef<string | null>(userId);
    const flushRunRef = useRef<PuzzleAttemptFlushRun | null>(null);
    const flushGenerationRef = useRef(0);
    const inFlightAttemptIdsRef = useRef<Set<string>>(new Set());
    const controllersRef = useRef<Set<AbortController>>(new Set());
    const [saving, setSaving] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const [queued, setQueued] = useState(0);
    const [online, setOnline] = useState(true);

    const flushQueue = useCallback(async () => {
        const scopedUserId = userId;
        if (
            typeof window === 'undefined' ||
            !scopedUserId ||
            sessionStatus !== 'authenticated' ||
            flushRunRef.current !== null
        ) {
            return;
        }

        const key = puzzleAttemptQueueStorageKey(scopedUserId);
        const run: PuzzleAttemptFlushRun = {
            userId: scopedUserId,
            generation: ++flushGenerationRef.current,
        };
        flushRunRef.current = run;
        setSaving(true);
        setLastError(null);
        try {
            while (activeUserRef.current === scopedUserId) {
                const item = readQueue(key)[0];
                if (!item) break;
                if (inFlightAttemptIdsRef.current.has(item.clientAttemptId)) {
                    await new Promise<void>((resolve) => {
                        window.setTimeout(resolve, 25);
                    });
                    continue;
                }

                const controller = new AbortController();
                controllersRef.current.add(controller);
                inFlightAttemptIdsRef.current.add(item.clientAttemptId);
                try {
                    await sendAttempt(item, controller.signal);
                    if (activeUserRef.current !== scopedUserId) break;
                    const removed = removeQueuedAttempt(
                        key,
                        item.clientAttemptId
                    );
                    setQueued(removed.count);
                    if (!removed.ok) {
                        setLastError(
                            'Attempt reached the server, but the offline queue could not be updated. It is safe to retry.'
                        );
                        break;
                    }
                } catch (error) {
                    if (
                        controller.signal.aborted ||
                        activeUserRef.current !== scopedUserId
                    ) {
                        break;
                    }
                    const status =
                        error instanceof AttemptSendError
                            ? error.status
                            : undefined;
                    if (status === 400 || status === 404 || status === 409) {
                        const removed = removeQueuedAttempt(
                            key,
                            item.clientAttemptId
                        );
                        setQueued(removed.count);
                        if (!removed.ok) {
                            setLastError(
                                'A corrupt queued item could not be removed because browser storage is unavailable.'
                            );
                            break;
                        }
                        continue;
                    }
                    setLastError(
                        status === 401 || status === 403
                            ? 'Your session changed. Attempts will sync after you sign in again.'
                            : error instanceof Error
                              ? error.message
                              : 'Failed to sync attempts'
                    );
                    break;
                } finally {
                    controllersRef.current.delete(controller);
                    inFlightAttemptIdsRef.current.delete(item.clientAttemptId);
                }
            }
        } finally {
            if (isCurrentPuzzleAttemptFlushRun(flushRunRef.current, run)) {
                flushRunRef.current = null;
                setSaving(false);
            }
            if (activeUserRef.current === scopedUserId) {
                setQueued(readQueue(key).length);
            }
        }
    }, [sessionStatus, userId]);

    useEffect(() => {
        activeUserRef.current = userId;
        for (const controller of controllersRef.current) controller.abort();
        controllersRef.current.clear();
        flushRunRef.current = null;
        setSaving(false);
        setLastError(null);
        if (typeof window === 'undefined' || !userId) {
            setQueued(0);
            return;
        }
        setQueued(readQueue(puzzleAttemptQueueStorageKey(userId)).length);
        if (sessionStatus === 'authenticated') void flushQueue();
    }, [flushQueue, sessionStatus, userId]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        setOnline(navigator.onLine);
        const onOnline = () => {
            setOnline(true);
            void flushQueue();
        };
        const onOffline = () => setOnline(false);
        const onFocus = () => void flushQueue();
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        window.addEventListener('focus', onFocus);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            window.removeEventListener('focus', onFocus);
        };
    }, [flushQueue]);

    const startAttempt = useCallback((puzzleId: string) => {
        if (!puzzleId) return;
        startRef.current = Date.now();
        setLastError(null);
    }, []);

    const persistPayload = useCallback(
        async (payload: QueuedAttempt) => {
            if (!userId || sessionStatus !== 'authenticated') {
                setLastError('Sign in to save puzzle activity.');
                return { ok: false as const };
            }
            const key = puzzleAttemptQueueStorageKey(userId);
            const queuedResult = enqueue(key, payload);
            if (queuedResult.ok) {
                setQueued(queuedResult.count);
                await flushQueue();
                const remainsQueued = readQueue(key).some(
                    (item) =>
                        item.clientAttemptId === payload.clientAttemptId
                );
                return {
                    ok: true as const,
                    queued: remainsQueued,
                    clientAttemptId: payload.clientAttemptId,
                };
            }

            const controller = new AbortController();
            controllersRef.current.add(controller);
            inFlightAttemptIdsRef.current.add(payload.clientAttemptId);
            setSaving(true);
            try {
                const directResult = await directSaveAfterQueueWriteFailure(
                    queuedResult.ok,
                    async () => {
                        await sendAttempt(payload, controller.signal);
                        if (activeUserRef.current !== userId) {
                            throw new Error('Session changed while saving');
                        }
                    }
                );
                if (directResult.ok) {
                    setLastError(null);
                    return {
                        ok: true as const,
                        queued: false as const,
                        clientAttemptId: payload.clientAttemptId,
                    };
                }
                const error = directResult.error;
                setLastError(
                    `Activity was not saved: browser storage is unavailable and direct save failed${
                        error instanceof Error ? ` (${error.message})` : ''
                    }.`
                );
                return { ok: false as const };
            } finally {
                controllersRef.current.delete(controller);
                inFlightAttemptIdsRef.current.delete(payload.clientAttemptId);
                setSaving(false);
            }
        },
        [flushQueue, sessionStatus, userId]
    );

    const recordAttempt = useCallback(
        async (args: { puzzleId: string; move: string; correct: boolean }) => {
            if (!args.puzzleId || !userId || sessionStatus !== 'authenticated') {
                setLastError('Sign in to save puzzle attempts.');
                return { ok: false as const };
            }
            const startedAt = startRef.current ?? Date.now();
            const payload: QueuedAttempt = {
                clientAttemptId: createClientAttemptId(),
                puzzleId: args.puzzleId,
                userMoveUci: args.move,
                wasCorrect: args.correct,
                timeSpentMs: Math.min(
                    MAX_PUZZLE_ATTEMPT_TIME_MS,
                    Math.max(0, Date.now() - startedAt)
                ),
                createdAt: Date.now(),
            };
            return persistPayload(payload);
        },
        [persistPayload, sessionStatus, userId]
    );

    const recordOutcome = useCallback(
        async (args: {
            puzzleId: string;
            outcome: PuzzleNonMoveOutcome;
        }) => {
            if (!args.puzzleId || !userId || sessionStatus !== 'authenticated') {
                setLastError('Sign in to save puzzle activity.');
                return { ok: false as const };
            }
            const startedAt = startRef.current ?? Date.now();
            return persistPayload({
                clientAttemptId: createClientAttemptId(),
                puzzleId: args.puzzleId,
                outcome: args.outcome,
                wasCorrect: false,
                timeSpentMs: Math.min(
                    MAX_PUZZLE_ATTEMPT_TIME_MS,
                    Math.max(0, Date.now() - startedAt)
                ),
                createdAt: Date.now(),
            });
        },
        [persistPayload, sessionStatus, userId]
    );

    return {
        startAttempt,
        recordAttempt,
        recordOutcome,
        flushQueue,
        saving,
        queued,
        lastError,
        online,
        syncState: saving
            ? ('saving' as const)
            : queued > 0
              ? ('queued' as const)
              : lastError
                ? ('error' as const)
                : ('saved' as const),
    };
}
