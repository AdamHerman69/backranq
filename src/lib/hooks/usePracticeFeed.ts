'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { useSession } from 'next-auth/react';

import type {
    PracticeFilters,
    RecordTrainingAttemptRequest,
    TrainingPromptDto,
} from '@/lib/training/api';
import {
    fetchTrainingMoment,
    fetchPracticeFeed,
    recordTrainingAttempt,
    TrainingClientError,
} from '@/lib/training/client';
import {
    enqueueTrainingAttempt,
    parseTrainingAttemptQueue,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
} from '@/lib/training/offlineQueue';
import { newClientId } from '@/lib/training/clientIds';
import {
    usePuzzleSession,
    type PuzzleSessionCompletion,
} from '@/lib/hooks/usePuzzleSession';
import {
    abortCoordinatedPracticeFeedRequest,
    startCoordinatedPracticeFeedRequest,
    type CoordinatedPracticeFeedRequest,
} from '@/lib/training/practiceFeedCoordinator';
import { recordPracticeExposureEvent } from '@/lib/training/exposureClient';
import { recordProgressEvent } from '@/lib/progress/analyticsClient';

export const PRACTICE_FEED_BATCH_SIZE = 12;
export const PRACTICE_FEED_LOW_WATER_MARK = 4;

export function practicePromptKey(prompt: TrainingPromptDto): string {
    return `${prompt.id}:${prompt.solutionRevisionId}`;
}

export function unseenPracticePrompts(
    prompts: readonly TrainingPromptDto[],
    seenKeys: ReadonlySet<string>
): TrainingPromptDto[] {
    const pageKeys = new Set<string>();
    return prompts.filter((prompt) => {
        const key = practicePromptKey(prompt);
        if (seenKeys.has(key) || pageKeys.has(key)) return false;
        pageKeys.add(key);
        return true;
    });
}

export function shouldPrefetchPracticeFeed({
    bufferedPositions,
    feedStarted,
    feedExhausted,
    online,
}: {
    bufferedPositions: number;
    feedStarted: boolean;
    feedExhausted: boolean;
    online: boolean;
}): boolean {
    return (
        online &&
        feedStarted &&
        !feedExhausted &&
        bufferedPositions <= PRACTICE_FEED_LOW_WATER_MARK
    );
}

type PracticeFeedReadOutcome =
    | { status: 'SUCCESS' }
    | { status: 'FAILURE'; error: unknown };

export function practiceFeedOnlineAfterRead({
    currentOnline,
    navigatorOnline,
    outcome,
}: {
    currentOnline: boolean;
    navigatorOnline: boolean;
    outcome: PracticeFeedReadOutcome;
}): boolean {
    if (!navigatorOnline) return false;
    return outcome.status === 'SUCCESS' ? true : currentOnline;
}

export function practiceFeedLoadErrorAfterEvent(
    currentError: string | null,
    event: 'ADVANCE_STARTED' | 'PAGE_SUCCEEDED' | 'PROMPT_ACTIVATED'
): string | null {
    if (
        event === 'ADVANCE_STARTED' ||
        event === 'PAGE_SUCCEEDED' ||
        event === 'PROMPT_ACTIVATED'
    ) {
        return null;
    }
    return currentError;
}

type ActiveExposure = {
    clientExposureId: string;
    momentId: string;
    solutionRevisionId: string;
    shownAt: string;
    terminalRecorded: boolean;
    terminalPending: boolean;
};

function errorMessage(error: unknown): string {
    if (error instanceof TrainingClientError) return error.message;
    return error instanceof Error
        ? error.message
        : 'The training service is unavailable.';
}

function navigatorIsOnline(): boolean {
    return (
        typeof navigator === 'undefined' || navigator.onLine !== false
    );
}

function shouldQueue(error: unknown): boolean {
    return (
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        error instanceof TypeError
    );
}

function keepQueued(error: unknown): boolean {
    if (!(error instanceof TrainingClientError)) return true;
    return error.status >= 500;
}

function readQueue(ownerId: string): QueuedTrainingAttempt[] {
    if (typeof window === 'undefined') return [];
    try {
        return parseTrainingAttemptQueue(
            window.localStorage.getItem(trainingQueueStorageKey(ownerId))
        ).filter((entry) => entry.ownerId === ownerId);
    } catch {
        return [];
    }
}

function writeQueue(
    ownerId: string,
    entries: QueuedTrainingAttempt[]
): boolean {
    if (typeof window === 'undefined') return false;
    try {
        const key = trainingQueueStorageKey(ownerId);
        if (entries.length === 0) {
            window.localStorage.removeItem(key);
            return true;
        }
        window.localStorage.setItem(key, JSON.stringify(entries));
        return true;
    } catch {
        return false;
    }
}

export function usePracticeFeed(
    initialMomentId?: string,
    ownerIdOverride?: string,
    entry?: 'progress'
) {
    const { data: session } = useSession();
    const ownerId = ownerIdOverride ?? session?.user?.id ?? null;

    const [buffer, setBuffer] = useState<TrainingPromptDto[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [feedStarted, setFeedStarted] = useState(false);
    const [appliedFilters, setAppliedFilters] =
        useState<PracticeFilters>({});
    const [feedRequest, setFeedRequest] = useState<{
        filters: PracticeFilters;
        revision: number;
    }>({ filters: {}, revision: 0 });
    const [loading, setLoading] = useState(true);
    const [feedExhausted, setFeedExhausted] = useState(false);
    const [feedHadPositions, setFeedHadPositions] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [error, setError] = useState<string | null>(null);
    const [online, setOnline] = useState(navigatorIsOnline);
    const [queuedCount, setQueuedCount] = useState(0);

    const flushInFlightRef = useRef(false);
    const advanceInFlightRef = useRef(false);
    const bufferRef = useRef<TrainingPromptDto[]>([]);
    const nextCursorRef = useRef<string | null>(null);
    const feedStartedRef = useRef(false);
    const feedExhaustedRef = useRef(false);
    const appliedFiltersRef = useRef<PracticeFilters>({});
    const requestedFiltersRef = useRef<PracticeFilters>({});
    const feedGenerationRef = useRef(0);
    const initialLoadControllerRef = useRef<AbortController | null>(null);
    const seenPromptKeysRef = useRef(new Set<string>());
    const pageRequestRef =
        useRef<
            CoordinatedPracticeFeedRequest<TrainingPromptDto[]> | null
        >(null);
    const activeExposureRef = useRef<ActiveExposure | null>(null);
    const progressStartRecordedRef = useRef(false);
    const completionSinkRef = useRef<
        (completion: PuzzleSessionCompletion) => void
    >(() => undefined);
    const puzzleSession = usePuzzleSession({
        unresolvedMode: 'RETRY',
        prewarmEngine: true,
        onCompleted: (completion) =>
            completionSinkRef.current(completion),
    });
    const {
        activatePrompt: activatePuzzlePrompt,
        clearPrompt: clearPuzzlePrompt,
        phase: puzzlePhase,
    } = puzzleSession;

    const recommendationKey =
        entry === 'progress'
            ? initialMomentId
                ? ('review-position' as const)
                : ('mixed-practice' as const)
            : undefined;

    const recordTerminalExposure = useCallback(
        (
            exposure: ActiveExposure,
            terminalReason:
                | 'MOVE_SUBMITTED'
                | 'REVEALED'
                | 'ABANDONED'
                | 'REPLACED'
                | 'NAVIGATED_AWAY',
            terminalAttemptId?: string
        ) => {
            if (exposure.terminalRecorded) return;
            exposure.terminalRecorded = true;
            const occurredAt = new Date().toISOString();
            void recordPracticeExposureEvent({
                kind: 'TERMINAL',
                clientExposureId: exposure.clientExposureId,
                clientEventId: newClientId(),
                momentId: exposure.momentId,
                solutionRevisionId:
                    exposure.solutionRevisionId,
                shownAt: exposure.shownAt,
                occurredAt,
                entry,
                recommendationKey,
                focus: appliedFiltersRef.current.focus,
                terminalReason,
                attemptId: terminalAttemptId,
            });
        },
        [entry, recommendationKey]
    );

    const finishExposure = useCallback(
        (
            terminalReason:
                | 'ABANDONED'
                | 'REPLACED'
                | 'NAVIGATED_AWAY'
        ) => {
            const exposure = activeExposureRef.current;
            if (
                !exposure ||
                exposure.terminalRecorded ||
                exposure.terminalPending
            ) {
                return;
            }
            recordTerminalExposure(exposure, terminalReason);
        },
        [recordTerminalExposure]
    );

    const finishExposureAfterPersistence = useCallback(
        (
            persistence: Promise<string | null>,
            terminalReason: 'MOVE_SUBMITTED' | 'REVEALED'
        ) => {
            const exposure = activeExposureRef.current;
            if (!exposure || exposure.terminalRecorded) return;
            exposure.terminalPending = true;
            void persistence.then((attemptId) => {
                exposure.terminalPending = false;
                if (attemptId) {
                    recordTerminalExposure(
                        exposure,
                        terminalReason,
                        attemptId
                    );
                } else {
                    recordTerminalExposure(
                        exposure,
                        'REPLACED'
                    );
                }
            });
        },
        [recordTerminalExposure]
    );

    const replaceBuffer = useCallback((positions: TrainingPromptDto[]) => {
        bufferRef.current = positions;
        setBuffer(positions);
    }, []);

    const updateCursor = useCallback((cursor: string | null) => {
        nextCursorRef.current = cursor;
        setNextCursor(cursor);
        const exhausted = cursor === null;
        feedExhaustedRef.current = exhausted;
        setFeedExhausted(exhausted);
    }, []);

    const activatePrompt = useCallback(
        (next: TrainingPromptDto) => {
            finishExposure('REPLACED');
            const shownAt = new Date().toISOString();
            const exposure: ActiveExposure = {
                clientExposureId: newClientId(),
                momentId: next.id,
                solutionRevisionId: next.solutionRevisionId,
                shownAt,
                terminalRecorded: false,
                terminalPending: false,
            };
            activeExposureRef.current = exposure;
            void recordPracticeExposureEvent({
                kind: 'SHOWN',
                clientExposureId: exposure.clientExposureId,
                clientEventId: newClientId(),
                momentId: next.id,
                solutionRevisionId: next.solutionRevisionId,
                shownAt,
                occurredAt: shownAt,
                entry,
                recommendationKey,
                focus: appliedFiltersRef.current.focus,
            });
            if (
                entry === 'progress' &&
                !progressStartRecordedRef.current
            ) {
                progressStartRecordedRef.current = true;
                void recordProgressEvent({
                    eventName:
                        'PRACTICE_STARTED_FROM_PROGRESS',
                    clientEventId: newClientId(),
                    occurredAt: shownAt,
                    recommendationKey,
                });
            }
            activatePuzzlePrompt(next);
            setError(null);
            setLoadError((current) =>
                practiceFeedLoadErrorAfterEvent(
                    current,
                    'PROMPT_ACTIVATED'
                )
            );
        },
        [
            entry,
            finishExposure,
            activatePuzzlePrompt,
            recommendationKey,
        ]
    );

    useEffect(
        () => () => finishExposure('NAVIGATED_AWAY'),
        [finishExposure]
    );

    const appendFeedPage = useCallback(
        (
            items: readonly TrainingPromptDto[],
            cursor: string | null,
            filters: PracticeFilters
        ): TrainingPromptDto[] => {
            const unseen = unseenPracticePrompts(
                items,
                seenPromptKeysRef.current
            );
            for (const item of unseen) {
                seenPromptKeysRef.current.add(practicePromptKey(item));
            }
            if (unseen.length > 0) {
                replaceBuffer([...bufferRef.current, ...unseen]);
                setFeedHadPositions(true);
            }
            appliedFiltersRef.current = filters;
            setAppliedFilters(filters);
            feedStartedRef.current = true;
            setFeedStarted(true);
            updateCursor(cursor);
            setOnline((current) =>
                practiceFeedOnlineAfterRead({
                    currentOnline: current,
                    navigatorOnline: navigatorIsOnline(),
                    outcome: { status: 'SUCCESS' },
                })
            );
            setLoadError((current) =>
                practiceFeedLoadErrorAfterEvent(
                    current,
                    'PAGE_SUCCEEDED'
                )
            );
            return unseen;
        },
        [replaceBuffer, updateCursor]
    );

    const startFeedPageRequest = useCallback(() => {
        if (feedStartedRef.current && feedExhaustedRef.current) {
            return Promise.resolve([]);
        }

        const generation = feedGenerationRef.current;
        const cursor = feedStartedRef.current
            ? nextCursorRef.current ?? undefined
            : undefined;
        const filters = feedStartedRef.current
            ? appliedFiltersRef.current
            : requestedFiltersRef.current;

        return startCoordinatedPracticeFeedRequest({
            slot: pageRequestRef,
            generation,
            isGenerationCurrent: (requestGeneration) =>
                requestGeneration === feedGenerationRef.current,
            request: (signal) =>
                fetchPracticeFeed(
                    {
                        limit: PRACTICE_FEED_BATCH_SIZE,
                        cursor,
                        filters,
                    },
                    signal
                ),
            onSuccess: (result) =>
                appendFeedPage(
                    result.items,
                    result.nextCursor,
                    result.appliedFilters
                ),
            onFailure: (caught) => {
                setOnline((current) =>
                    practiceFeedOnlineAfterRead({
                        currentOnline: current,
                        navigatorOnline: navigatorIsOnline(),
                        outcome: { status: 'FAILURE', error: caught },
                    })
                );
            },
            staleResult: () => [],
        });
    }, [appendFeedPage]);

    const loadInitial = useCallback(
        async (generation: number, signal: AbortSignal) => {
            setLoading(true);
            setLoadError(null);
            try {
                if (initialMomentId) {
                    const detail = await fetchTrainingMoment(
                        initialMomentId,
                        signal
                    );
                    if (
                        signal.aborted ||
                        generation !== feedGenerationRef.current
                    ) {
                        return;
                    }
                    seenPromptKeysRef.current.add(
                        practicePromptKey(detail.moment)
                    );
                    replaceBuffer([]);
                    nextCursorRef.current = null;
                    setNextCursor(null);
                    appliedFiltersRef.current = {};
                    setAppliedFilters({});
                    feedStartedRef.current = false;
                    setFeedStarted(false);
                    feedExhaustedRef.current = false;
                    setFeedExhausted(false);
                    setFeedHadPositions(true);
                    setOnline((current) =>
                        practiceFeedOnlineAfterRead({
                            currentOnline: current,
                            navigatorOnline: navigatorIsOnline(),
                            outcome: { status: 'SUCCESS' },
                        })
                    );
                    activatePrompt(detail.moment);
                    void startFeedPageRequest().catch(() => {
                        // The deep-linked position remains fully usable even if
                        // the next practice page cannot be prepared yet.
                    });
                    return;
                }

                const result = await fetchPracticeFeed(
                    {
                        limit: PRACTICE_FEED_BATCH_SIZE,
                        filters: feedRequest.filters,
                    },
                    signal
                );
                if (
                    signal.aborted ||
                    generation !== feedGenerationRef.current
                ) {
                    return;
                }
                const unseen = unseenPracticePrompts(
                    result.items,
                    seenPromptKeysRef.current
                );
                for (const item of unseen) {
                    seenPromptKeysRef.current.add(practicePromptKey(item));
                }
                feedStartedRef.current = true;
                setFeedStarted(true);
                setOnline((current) =>
                    practiceFeedOnlineAfterRead({
                        currentOnline: current,
                        navigatorOnline: navigatorIsOnline(),
                        outcome: { status: 'SUCCESS' },
                    })
                );
                appliedFiltersRef.current = result.appliedFilters;
                setAppliedFilters(result.appliedFilters);
                updateCursor(result.nextCursor);
                const [first, ...rest] = unseen;
                setFeedHadPositions(Boolean(first));
                replaceBuffer(rest);
                if (first) {
                    activatePrompt(first);
                } else {
                    clearPuzzlePrompt();
                }
            } catch (caught) {
                if (
                    signal.aborted ||
                    generation !== feedGenerationRef.current
                ) {
                    return;
                }
                setOnline((current) =>
                    practiceFeedOnlineAfterRead({
                        currentOnline: current,
                        navigatorOnline: navigatorIsOnline(),
                        outcome: { status: 'FAILURE', error: caught },
                    })
                );
                setLoadError(errorMessage(caught));
                clearPuzzlePrompt();
            } finally {
                if (
                    !signal.aborted &&
                    generation === feedGenerationRef.current
                ) {
                    setLoading(false);
                }
            }
        },
        [
            activatePrompt,
            feedRequest,
            initialMomentId,
            replaceBuffer,
            clearPuzzlePrompt,
            startFeedPageRequest,
            updateCursor,
        ]
    );

    useEffect(() => {
        const generation = feedGenerationRef.current + 1;
        feedGenerationRef.current = generation;
        initialLoadControllerRef.current?.abort();
        abortCoordinatedPracticeFeedRequest(pageRequestRef);
        const controller = new AbortController();
        initialLoadControllerRef.current = controller;
        seenPromptKeysRef.current = new Set();
        bufferRef.current = [];
        nextCursorRef.current = null;
        feedStartedRef.current = false;
        feedExhaustedRef.current = false;
        appliedFiltersRef.current = {};
        requestedFiltersRef.current = feedRequest.filters;
        clearPuzzlePrompt();
        replaceBuffer([]);
        setNextCursor(null);
        setFeedStarted(false);
        setFeedExhausted(false);
        setFeedHadPositions(false);
        setAppliedFilters({});
        void loadInitial(generation, controller.signal);
        return () => {
            controller.abort();
            abortCoordinatedPracticeFeedRequest(
                pageRequestRef,
                generation
            );
            if (initialLoadControllerRef.current === controller) {
                initialLoadControllerRef.current = null;
            }
            if (generation === feedGenerationRef.current) {
                feedGenerationRef.current += 1;
            }
        };
    }, [
        feedRequest.filters,
        loadInitial,
        clearPuzzlePrompt,
        replaceBuffer,
    ]);

    useEffect(() => {
        const onOnline = () => setOnline(true);
        const onOffline = () => setOnline(false);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, []);

    useEffect(() => {
        if (
            !shouldPrefetchPracticeFeed({
                bufferedPositions: buffer.length,
                feedStarted,
                feedExhausted,
                online,
            })
        ) {
            return;
        }
        void startFeedPageRequest().catch(() => {
            // Keep already-buffered prompts playable. Moving closer to an empty
            // buffer, reconnecting, or an explicit retry will start a new page
            // request without replacing the current position.
        });
    }, [
        buffer.length,
        feedExhausted,
        feedStarted,
        nextCursor,
        online,
        startFeedPageRequest,
    ]);

    useEffect(() => {
        setQueuedCount(ownerId ? readQueue(ownerId).length : 0);
    }, [ownerId]);

    const queueRecord = useCallback(
        (momentId: string, request: RecordTrainingAttemptRequest) => {
            if (!ownerId) return;
            const entry: QueuedTrainingAttempt = {
                version: 2,
                ownerId,
                momentId,
                request,
                queuedAt: new Date().toISOString(),
            };
            const next = enqueueTrainingAttempt(
                readQueue(ownerId),
                entry
            );
            if (writeQueue(ownerId, next)) {
                setQueuedCount(next.length);
            } else {
                setError(
                    'Your result is graded, but it could not be queued for history sync.'
                );
            }
        },
        [ownerId]
    );

    const persistRecord = useCallback(
        async (
            momentId: string,
            request: RecordTrainingAttemptRequest
        ) => {
            if (!ownerId || !online) {
                queueRecord(momentId, request);
                return null;
            }
            try {
                const recorded = await recordTrainingAttempt(
                    momentId,
                    request
                );
                return recorded.attemptId;
            } catch (caught) {
                queueRecord(momentId, request);
                if (shouldQueue(caught)) setOnline(false);
                return null;
            }
        },
        [online, ownerId, queueRecord]
    );

    completionSinkRef.current = (completion) => {
        setError(null);
        const persistence = persistRecord(
            completion.prompt.id,
            completion.request
        );
        finishExposureAfterPersistence(
            persistence,
            completion.terminalReason
        );
    };

    const flushQueue = useCallback(async () => {
        if (!ownerId || !online || flushInFlightRef.current) return;
        flushInFlightRef.current = true;
        try {
            const queued = readQueue(ownerId);
            const remainingEntries: QueuedTrainingAttempt[] = [];
            for (let index = 0; index < queued.length; index += 1) {
                const entry = queued[index]!;
                try {
                    await recordTrainingAttempt(
                        entry.momentId,
                        entry.request
                    );
                } catch (caught) {
                    if (keepQueued(caught)) {
                        remainingEntries.push(
                            ...queued.slice(index)
                        );
                        if (shouldQueue(caught)) setOnline(false);
                        break;
                    }
                }
            }
            if (!writeQueue(ownerId, remainingEntries)) {
                setError(
                    'Practice history synced, but local queue cleanup failed.'
                );
            }
            setQueuedCount(remainingEntries.length);
        } finally {
            flushInFlightRef.current = false;
        }
    }, [online, ownerId]);

    useEffect(() => {
        if (online && queuedCount > 0) void flushQueue();
    }, [flushQueue, online, queuedCount]);

    const next = useCallback(async () => {
        if (advanceInFlightRef.current) return;
        advanceInFlightRef.current = true;
        try {
            if (
                loading ||
                puzzlePhase === 'SUBMITTING' ||
                puzzlePhase === 'AWAITING_MOVE'
            ) {
                return;
            }
            finishExposure('REPLACED');

            setLoadError((current) =>
                practiceFeedLoadErrorAfterEvent(
                    current,
                    'ADVANCE_STARTED'
                )
            );
            const [first, ...rest] = bufferRef.current;
            if (first) {
                replaceBuffer(rest);
                activatePrompt(first);
                return;
            }

            if (feedStartedRef.current && feedExhaustedRef.current) {
                clearPuzzlePrompt();
                return;
            }

            const generation = feedGenerationRef.current;
            setLoading(true);
            try {
                while (
                    generation === feedGenerationRef.current &&
                    bufferRef.current.length === 0 &&
                    !(
                        feedStartedRef.current &&
                        feedExhaustedRef.current
                    )
                ) {
                    await startFeedPageRequest();
                }
                if (generation !== feedGenerationRef.current) return;

                const [nextPrompt, ...restPrompts] =
                    bufferRef.current;
                if (nextPrompt) {
                    replaceBuffer(restPrompts);
                    setFeedHadPositions(true);
                    activatePrompt(nextPrompt);
                } else {
                    clearPuzzlePrompt();
                }
            } catch (caught) {
                if (generation !== feedGenerationRef.current) return;
                setLoadError(errorMessage(caught));
            } finally {
                if (generation === feedGenerationRef.current) {
                    setLoading(false);
                }
            }
        } finally {
            advanceInFlightRef.current = false;
        }
    }, [
        activatePrompt,
        finishExposure,
        loading,
        clearPuzzlePrompt,
        puzzlePhase,
        replaceBuffer,
        startFeedPageRequest,
    ]);

    const resetFeed = useCallback(
        (filters: PracticeFilters) => {
            if (initialMomentId) return;
            finishExposure('REPLACED');
            feedGenerationRef.current += 1;
            initialLoadControllerRef.current?.abort();
            abortCoordinatedPracticeFeedRequest(pageRequestRef);
            requestedFiltersRef.current = filters;
            bufferRef.current = [];
            nextCursorRef.current = null;
            feedStartedRef.current = false;
            feedExhaustedRef.current = false;
            appliedFiltersRef.current = {};
            seenPromptKeysRef.current = new Set();
            setLoading(true);
            setLoadError(null);
            clearPuzzlePrompt();
            replaceBuffer([]);
            setNextCursor(null);
            setFeedStarted(false);
            setAppliedFilters({});
            setFeedExhausted(false);
            setFeedHadPositions(false);
            setError(null);
            setFeedRequest((current) => ({
                filters,
                revision: current.revision + 1,
            }));
        },
        [
            finishExposure,
            initialMomentId,
            clearPuzzlePrompt,
            replaceBuffer,
        ]
    );

    const retryFeed = useCallback(() => {
        feedGenerationRef.current += 1;
        initialLoadControllerRef.current?.abort();
        abortCoordinatedPracticeFeedRequest(pageRequestRef);
        setLoading(true);
        setLoadError(null);
        setFeedRequest((current) => ({
            ...current,
            revision: current.revision + 1,
        }));
    }, []);

    return {
        ...puzzleSession,
        loading,
        feedExhausted,
        feedHadPositions,
        bufferedPositions: buffer.length,
        loadError,
        error,
        online,
        queuedCount,
        flushQueue,
        next,
        resetFeed,
        practiceFilters: feedRequest.filters,
        appliedPracticeFilters: appliedFilters,
        retryFeed,
    };
}
