'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { useSession } from 'next-auth/react';

import type {
    PracticeFeedMode,
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
    classifyTrainingWriteFailure,
    enqueueTrainingAttempt,
    failedTrainingAttempt,
    parseTrainingAttemptQueue,
    reconcileTrainingAttemptFlush,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
    type TrainingWriteFailure,
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
    ownerId: string;
    clientExposureId: string;
    momentId: string;
    solutionRevisionId: string;
    shownAt: string;
    terminalRecorded: boolean;
    terminalPending: boolean;
};

export function resolvePracticeOwnerId({
    sessionStatus,
    liveOwnerId,
    initialOwnerId,
}: {
    sessionStatus: 'loading' | 'authenticated' | 'unauthenticated';
    liveOwnerId: string | null;
    initialOwnerId?: string;
}): string | null {
    return sessionStatus === 'loading'
        ? (liveOwnerId ?? initialOwnerId ?? null)
        : liveOwnerId;
}

export function isPracticeOwnerRunCurrent({
    expectedOwnerId,
    currentOwnerId,
    generation,
    currentGeneration,
}: {
    expectedOwnerId: string;
    currentOwnerId: string | null;
    generation: number;
    currentGeneration: number;
}): boolean {
    return (
        expectedOwnerId === currentOwnerId &&
        generation === currentGeneration
    );
}

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
    entry?: 'progress',
    initialMode?: PracticeFeedMode,
    initialGameId?: string
) {
    const { data: session, status: sessionStatus } = useSession();
    const ownerId = resolvePracticeOwnerId({
        sessionStatus,
        liveOwnerId: session?.user?.id ?? null,
        initialOwnerId: ownerIdOverride,
    });

    const [buffer, setBuffer] = useState<TrainingPromptDto[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [feedStarted, setFeedStarted] = useState(false);
    const [appliedFilters, setAppliedFilters] =
        useState<PracticeFilters>({});
    const [feedRequest, setFeedRequest] = useState<{
        filters: PracticeFilters;
        revision: number;
    }>(() => ({
        filters: {
            ...(initialMode ? { mode: initialMode } : {}),
            ...(initialGameId ? { gameId: initialGameId } : {}),
        },
        revision: 0,
    }));
    const [loading, setLoading] = useState(true);
    const [feedExhausted, setFeedExhausted] = useState(false);
    const [feedHadPositions, setFeedHadPositions] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loadedOwnerId, setLoadedOwnerId] = useState<string | null>(null);

    const [online, setOnline] = useState(navigatorIsOnline);
    const [queuedCount, setQueuedCount] = useState(0);
    const [failedHistoryWrites, setFailedHistoryWrites] = useState<
        QueuedTrainingAttempt[]
    >([]);
    const [historyError, setHistoryError] = useState<string | null>(null);

    const flushInFlightRef = useRef(false);
    const flushControllerRef = useRef<AbortController | null>(null);
    const attemptWriteControllersRef = useRef(new Set<AbortController>());
    const ownerIdRef = useRef(ownerId);
    ownerIdRef.current = ownerId;
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
            if (
                exposure.terminalRecorded ||
                ownerIdRef.current !== exposure.ownerId
            ) {
                return;
            }
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
                ownerId: ownerIdRef.current ?? '',
                clientExposureId: newClientId(),
                momentId: next.id,
                solutionRevisionId: next.solutionRevisionId,
                shownAt,
                terminalRecorded: false,
                terminalPending: false,
            };
            if (!exposure.ownerId) return;
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

    const invalidateFeedForOwnerMismatch = useCallback(
        (message: string) => {
            feedGenerationRef.current += 1;
            initialLoadControllerRef.current?.abort();
            abortCoordinatedPracticeFeedRequest(pageRequestRef);
            activeExposureRef.current = null;
            seenPromptKeysRef.current = new Set();
            bufferRef.current = [];
            nextCursorRef.current = null;
            feedStartedRef.current = false;
            feedExhaustedRef.current = false;
            appliedFiltersRef.current = {};
            setLoadedOwnerId(null);
            clearPuzzlePrompt();
            replaceBuffer([]);
            setNextCursor(null);
            setFeedStarted(false);
            setFeedExhausted(false);
            setFeedHadPositions(false);
            setAppliedFilters({});
            setLoading(false);
            setLoadError(message);
        },
        [clearPuzzlePrompt, replaceBuffer]
    );

    const appendFeedPage = useCallback(
        (
            items: readonly TrainingPromptDto[],
            cursor: string | null,
            filters: PracticeFilters,
            responseOwnerId: string
        ): TrainingPromptDto[] => {
            setLoadedOwnerId(responseOwnerId);
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
        const requestOwnerId = ownerId;
        if (!requestOwnerId) return Promise.resolve([]);
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
                isPracticeOwnerRunCurrent({
                    expectedOwnerId: requestOwnerId,
                    currentOwnerId: ownerIdRef.current,
                    generation: requestGeneration,
                    currentGeneration: feedGenerationRef.current,
                }),
            request: (signal) =>
                fetchPracticeFeed(
                    requestOwnerId,
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
                    result.appliedFilters,
                    result.ownerId
                ),
            onFailure: (caught) => {
                if (
                    caught instanceof TrainingClientError &&
                    caught.code === 'OWNER_MISMATCH'
                ) {
                    invalidateFeedForOwnerMismatch(caught.message);
                    return;
                }
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
    }, [appendFeedPage, invalidateFeedForOwnerMismatch, ownerId]);

    const loadInitial = useCallback(
        async (generation: number, signal: AbortSignal) => {
            setLoading(true);
            setLoadError(null);
            const requestOwnerId = ownerId;
            if (!requestOwnerId) {
                setLoading(false);
                clearPuzzlePrompt();
                return;
            }
            const isCurrent = () =>
                !signal.aborted &&
                isPracticeOwnerRunCurrent({
                    expectedOwnerId: requestOwnerId,
                    currentOwnerId: ownerIdRef.current,
                    generation,
                    currentGeneration: feedGenerationRef.current,
                });
            try {
                if (initialMomentId) {
                    const detail = await fetchTrainingMoment(
                        requestOwnerId,
                        initialMomentId,
                        signal
                    );
                    if (!isCurrent()) return;
                    setLoadedOwnerId(detail.ownerId);
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
                    requestOwnerId,
                    {
                        limit: PRACTICE_FEED_BATCH_SIZE,
                        filters: feedRequest.filters,
                    },
                    signal
                );
                if (!isCurrent()) return;
                setLoadedOwnerId(result.ownerId);
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
                if (!isCurrent()) return;
                if (
                    caught instanceof TrainingClientError &&
                    caught.code === 'OWNER_MISMATCH'
                ) {
                    invalidateFeedForOwnerMismatch(caught.message);
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
                if (isCurrent()) {
                    setLoading(false);
                }
            }
        },
        [
            activatePrompt,
            feedRequest,
            initialMomentId,
            invalidateFeedForOwnerMismatch,
            ownerId,
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
        activeExposureRef.current = null;
        requestedFiltersRef.current = feedRequest.filters;
        setLoadedOwnerId(null);
        clearPuzzlePrompt();
        replaceBuffer([]);
        setNextCursor(null);
        setFeedStarted(false);
        setFeedExhausted(false);
        setFeedHadPositions(false);
        setAppliedFilters({});
        if (ownerId) {
            void loadInitial(generation, controller.signal);
        } else {
            setLoading(false);
        }
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
        ownerId,
        loadInitial,
        clearPuzzlePrompt,
        replaceBuffer,
    ]);

    useEffect(() => {
        const controllers = attemptWriteControllersRef.current;
        return () => {
            for (const controller of controllers) {
                controller.abort();
            }
            controllers.clear();
        };
    }, [ownerId]);

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

    const applyOutboxState = useCallback(
        (entries: QueuedTrainingAttempt[]) => {
            if (!ownerId || ownerIdRef.current !== ownerId) return;
            setQueuedCount(
                entries.filter((entry) => entry.state === 'PENDING').length
            );
            setFailedHistoryWrites(
                entries.filter(
                    (entry) => entry.state === 'NEEDS_ATTENTION'
                )
            );
        },
        [ownerId]
    );

    useEffect(() => {
        flushControllerRef.current?.abort();
        flushInFlightRef.current = false;
        setHistoryError(null);
        if (!ownerId) {
            setQueuedCount(0);
            setFailedHistoryWrites([]);
            return;
        }
        applyOutboxState(readQueue(ownerId));
        return () => flushControllerRef.current?.abort();
    }, [applyOutboxState, ownerId]);

    const queueRecord = useCallback(
        (
            momentId: string,
            request: RecordTrainingAttemptRequest,
            failure?: TrainingWriteFailure
        ) => {
            if (!ownerId || ownerIdRef.current !== ownerId) return;
            const attemptedAt = failure ? new Date().toISOString() : null;
            const entry: QueuedTrainingAttempt = {
                version: 3,
                ownerId,
                momentId,
                request,
                queuedAt: new Date().toISOString(),
                state:
                    failure?.disposition === 'NEEDS_ATTENTION'
                        ? 'NEEDS_ATTENTION'
                        : 'PENDING',
                attemptCount: failure ? 1 : 0,
                lastAttemptAt: attemptedAt,
                lastError: failure?.error ?? null,
            };
            const next = enqueueTrainingAttempt(
                readQueue(ownerId),
                entry
            );
            const stored = next.some(
                (candidate) =>
                    candidate.request.clientAttemptId ===
                    request.clientAttemptId
            );
            if (stored && writeQueue(ownerId, next)) {
                applyOutboxState(next);
            } else {
                setHistoryError(
                    stored
                        ? 'Your result is graded, but local history storage is unavailable.'
                        : 'Local history storage is full. Resolve an earlier unsaved result before continuing.'
                );
            }
        },
        [applyOutboxState, ownerId]
    );

    const persistRecord = useCallback(
        async (
            momentId: string,
            request: RecordTrainingAttemptRequest
        ) => {
            const requestOwnerId = ownerId;
            if (!requestOwnerId || ownerIdRef.current !== requestOwnerId) {
                return null;
            }
            if (!online) {
                queueRecord(momentId, request);
                return null;
            }
            const controller = new AbortController();
            attemptWriteControllersRef.current.add(controller);
            try {
                const recorded = await recordTrainingAttempt(
                    requestOwnerId,
                    momentId,
                    request,
                    controller.signal
                );
                if (
                    controller.signal.aborted ||
                    ownerIdRef.current !== requestOwnerId
                ) {
                    return null;
                }
                return recorded.attemptId;
            } catch (caught) {
                if (
                    controller.signal.aborted ||
                    ownerIdRef.current !== requestOwnerId ||
                    (caught instanceof Error &&
                        caught.name === 'AbortError')
                ) {
                    return null;
                }
                const failure = classifyTrainingWriteFailure(
                    caught,
                    navigatorIsOnline()
                );
                queueRecord(momentId, request, failure);
                if (failure.offline) setOnline(false);
                return null;
            } finally {
                attemptWriteControllersRef.current.delete(controller);
            }
        },
        [online, ownerId, queueRecord]
    );

    completionSinkRef.current = (completion) => {
        if (loadedOwnerId !== ownerId || !ownerId) return;
        setHistoryError(null);
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
        if (
            !ownerId ||
            ownerIdRef.current !== ownerId ||
            !online ||
            flushInFlightRef.current
        ) {
            return;
        }
        flushInFlightRef.current = true;
        const controller = new AbortController();
        flushControllerRef.current?.abort();
        flushControllerRef.current = controller;
        try {
            const queued = readQueue(ownerId);
            const remainingEntries: QueuedTrainingAttempt[] = [];
            for (let index = 0; index < queued.length; index += 1) {
                const entry = queued[index]!;
                if (entry.state === 'NEEDS_ATTENTION') {
                    remainingEntries.push(entry);
                    continue;
                }
                try {
                    await recordTrainingAttempt(
                        ownerId,
                        entry.momentId,
                        entry.request,
                        controller.signal
                    );
                    if (
                        controller.signal.aborted ||
                        ownerIdRef.current !== ownerId
                    ) {
                        return;
                    }
                } catch (caught) {
                    if (
                        controller.signal.aborted ||
                        ownerIdRef.current !== ownerId ||
                        (caught instanceof Error &&
                            caught.name === 'AbortError')
                    ) {
                        return;
                    }
                    const failure = classifyTrainingWriteFailure(
                        caught,
                        navigatorIsOnline()
                    );
                    remainingEntries.push(
                        failedTrainingAttempt(
                            entry,
                            failure,
                            new Date().toISOString()
                        )
                    );
                    if (failure.offline) setOnline(false);
                    if (failure.disposition === 'RETRY') {
                        remainingEntries.push(...queued.slice(index + 1));
                        break;
                    }
                }
            }
            if (
                controller.signal.aborted ||
                ownerIdRef.current !== ownerId
            ) {
                return;
            }
            const reconciledEntries = reconcileTrainingAttemptFlush(
                queued,
                remainingEntries,
                readQueue(ownerId)
            );
            if (!writeQueue(ownerId, reconciledEntries)) {
                setHistoryError(
                    'Practice history synced, but local queue cleanup failed.'
                );
            }
            applyOutboxState(reconciledEntries);
        } finally {
            if (flushControllerRef.current === controller) {
                flushControllerRef.current = null;
                flushInFlightRef.current = false;
            }
        }
    }, [applyOutboxState, online, ownerId]);

    useEffect(() => {
        if (online && queuedCount > 0) void flushQueue();
    }, [flushQueue, online, queuedCount]);

    const retryHistoryWrite = useCallback(
        (clientAttemptId: string) => {
            if (!ownerId || ownerIdRef.current !== ownerId) return;
            const next = readQueue(ownerId).map((entry) =>
                entry.request.clientAttemptId === clientAttemptId
                    ? {
                          ...entry,
                          state: 'PENDING' as const,
                          lastError: null,
                      }
                    : entry
            );
            if (!writeQueue(ownerId, next)) {
                setHistoryError('The unsaved result could not be updated locally.');
                return;
            }
            applyOutboxState(next);
        },
        [applyOutboxState, ownerId]
    );

    const dismissHistoryWrite = useCallback(
        (clientAttemptId: string) => {
            if (!ownerId || ownerIdRef.current !== ownerId) return;
            const next = readQueue(ownerId).filter(
                (entry) =>
                    entry.request.clientAttemptId !== clientAttemptId
            );
            if (!writeQueue(ownerId, next)) {
                setHistoryError('The unsaved result could not be removed locally.');
                return;
            }
            applyOutboxState(next);
        },
        [applyOutboxState, ownerId]
    );

    const next = useCallback(async () => {
        if (!ownerId || loadedOwnerId !== ownerId) return;
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
        loadedOwnerId,
        ownerId,
        clearPuzzlePrompt,
        puzzlePhase,
        replaceBuffer,
        startFeedPageRequest,
    ]);

    const resetFeed = useCallback(
        (filters: PracticeFilters) => {
            if (!ownerId || initialMomentId) return;
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
            setHistoryError(null);
            setFeedRequest((current) => ({
                filters: {
                    ...filters,
                    ...(initialGameId ? { gameId: initialGameId } : {}),
                },
                revision: current.revision + 1,
            }));
        },
        [
            finishExposure,
            initialMomentId,
            initialGameId,
            ownerId,
            clearPuzzlePrompt,
            replaceBuffer,
        ]
    );

    const retryFeed = useCallback(() => {
        if (!ownerId) return;
        feedGenerationRef.current += 1;
        initialLoadControllerRef.current?.abort();
        abortCoordinatedPracticeFeedRequest(pageRequestRef);
        setLoading(true);
        setLoadError(null);
        setFeedRequest((current) => ({
            ...current,
            revision: current.revision + 1,
        }));
    }, [ownerId]);

    const ownerReady = Boolean(ownerId && loadedOwnerId === ownerId);

    return {
        ...puzzleSession,
        canMove: ownerReady && puzzleSession.canMove,
        ownerReady,
        loading,
        feedExhausted,
        feedHadPositions,
        bufferedPositions: buffer.length,
        loadError,
        historyError,
        failedHistoryWrites,
        online,
        queuedCount,
        flushQueue,
        retryHistoryWrite,
        dismissHistoryWrite,
        next,
        resetFeed,
        practiceFilters: feedRequest.filters,
        appliedPracticeFilters: appliedFilters,
        retryFeed,
    };
}
