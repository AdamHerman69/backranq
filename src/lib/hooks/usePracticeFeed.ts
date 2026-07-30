'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { useSession } from 'next-auth/react';

import type {
    GradedTrainingAttemptResponse,
    PracticeFilters,
    RevealTrainingMomentResponse,
    SubmitTrainingAttemptRequest,
    SubmitTrainingAttemptResponse,
    TrainingPromptDto,
} from '@/lib/training/api';
import {
    fetchTrainingMoment,
    fetchPracticeFeed,
    revealTrainingMoment,
    submitTrainingAttempt,
    TrainingClientError,
} from '@/lib/training/client';
import {
    enqueueTrainingAttempt,
    parseTrainingAttemptQueue,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
} from '@/lib/training/offlineQueue';
import {
    nextFenFromAuthoritativeResponse,
    reviewFromAuthoritativeResponse,
    type TrainerAttemptPhase,
} from '@/lib/training/trainerState';
import {
    abortCoordinatedPracticeFeedRequest,
    startCoordinatedPracticeFeedRequest,
    type CoordinatedPracticeFeedRequest,
} from '@/lib/training/practiceFeedCoordinator';

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

type LastSubmission = {
    momentId: string;
    request: SubmitTrainingAttemptRequest;
    fenBefore: string;
    fenAfterMove: string;
};

function phaseBeforeSubmission(
    request: SubmitTrainingAttemptRequest
): TrainerAttemptPhase {
    if (request.kind === 'STEP') return 'AWAITING_MOVE';
    if (request.kind === 'RETRY') return 'UNRESOLVED';
    return 'READY';
}

function newClientAttemptId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
        /[xy]/g,
        (character) => {
            const random = Math.floor(Math.random() * 16);
            const value = character === 'x' ? random : (random & 0x3) | 0x8;
            return value.toString(16);
        }
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

function shouldQueue(error: unknown): boolean {
    return (
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        error instanceof TypeError
    );
}

function keepQueued(error: unknown): boolean {
    if (!(error instanceof TrainingClientError)) return true;
    return (
        error.status >= 500 ||
        error.code === 'GRADING_BUSY' ||
        error.code === 'RATE_LIMITED'
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
    ownerIdOverride?: string
) {
    const { data: session } = useSession();
    const ownerId = ownerIdOverride ?? session?.user?.id ?? null;

    const [prompt, setPrompt] = useState<TrainingPromptDto | null>(null);
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

    const [positionFen, setPositionFen] = useState<string | null>(null);
    const [phase, setPhase] = useState<TrainerAttemptPhase>('READY');
    const [response, setResponse] = useState<
        SubmitTrainingAttemptResponse | RevealTrainingMomentResponse | null
    >(null);
    const [attemptId, setAttemptId] = useState<string | null>(null);
    const [nextStepIndex, setNextStepIndex] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [online, setOnline] = useState(navigatorIsOnline);
    const [queuedCount, setQueuedCount] = useState(0);

    const clientAttemptIdRef = useRef<string | null>(null);
    const promptStartedAtRef = useRef(Date.now());
    const lastSubmissionRef = useRef<LastSubmission | null>(null);
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
            const queued = ownerId
                ? readQueue(ownerId).find(
                      (entry) => entry.momentId === next.id
                  ) ?? null
                : null;
            setPrompt(next);
            setPositionFen(queued?.fenAfterMove ?? next.fen);
            setPhase(queued ? 'PENDING_GRADING' : 'READY');
            setResponse(null);
            setAttemptId(null);
            setNextStepIndex(null);
            setError(null);
            setLoadError((current) =>
                practiceFeedLoadErrorAfterEvent(
                    current,
                    'PROMPT_ACTIVATED'
                )
            );
            clientAttemptIdRef.current =
                queued?.request.clientAttemptId ?? null;
            lastSubmissionRef.current = queued
                ? {
                      momentId: queued.momentId,
                      request: queued.request,
                      fenBefore: queued.fenBefore,
                      fenAfterMove: queued.fenAfterMove,
                  }
                : null;
            promptStartedAtRef.current = Date.now();
        },
        [ownerId]
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
                    setPrompt(null);
                    setPositionFen(null);
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
                setPrompt(null);
                setPositionFen(null);
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
        setPrompt(null);
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
    }, [feedRequest.filters, loadInitial, replaceBuffer]);

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

    const applyResponse = useCallback(
        (
            authoritative: SubmitTrainingAttemptResponse,
            submittedFen: string
        ) => {
            setResponse(authoritative);
            setPositionFen(
                nextFenFromAuthoritativeResponse(
                    submittedFen,
                    authoritative
                )
            );
            setError(null);

            if (authoritative.status === 'GRADED') {
                setAttemptId(authoritative.attemptId);
                setNextStepIndex(null);
                setPhase('GRADED');
            } else if (
                authoritative.status === 'AWAITING_CONTINUATION'
            ) {
                setAttemptId(authoritative.attemptId);
                setNextStepIndex(authoritative.nextStepIndex);
                setPhase('AWAITING_MOVE');
                promptStartedAtRef.current = Date.now();
            } else {
                setAttemptId(authoritative.attemptId);
                setNextStepIndex(null);
                setPhase('UNRESOLVED');
            }
        },
        []
    );

    const queueSubmission = useCallback(
        (submission: LastSubmission) => {
            if (!ownerId) {
                setError('Sign in again before saving this move.');
                setPositionFen(
                    submission.request.kind === 'RETRY'
                        ? submission.fenAfterMove
                        : submission.fenBefore
                );
                setPhase(phaseBeforeSubmission(submission.request));
                return;
            }
            const entry: QueuedTrainingAttempt = {
                version: 1,
                ownerId,
                momentId: submission.momentId,
                request: submission.request,
                fenBefore: submission.fenBefore,
                fenAfterMove: submission.fenAfterMove,
                queuedAt: new Date().toISOString(),
            };
            const next = enqueueTrainingAttempt(readQueue(ownerId), entry);
            if (!writeQueue(ownerId, next)) {
                setError(
                    'This move could not be stored offline. Reconnect and try again.'
                );
                setPositionFen(
                    submission.request.kind === 'RETRY'
                        ? submission.fenAfterMove
                        : submission.fenBefore
                );
                setPhase(phaseBeforeSubmission(submission.request));
                return;
            }
            setQueuedCount(next.length);
            setPhase('PENDING_GRADING');
            setError(null);
        },
        [ownerId]
    );

    const submitMove = useCallback(
        async ({
            moveUci,
            fenAfterMove,
        }: {
            moveUci: string;
            fenAfterMove: string;
        }) => {
            if (
                !prompt ||
                !positionFen ||
                (phase !== 'READY' && phase !== 'AWAITING_MOVE')
            ) {
                return;
            }

            const fenBefore = positionFen;
            const elapsed = Math.max(
                0,
                Math.min(Date.now() - promptStartedAtRef.current, 86_400_000)
            );
            if (!clientAttemptIdRef.current) {
                clientAttemptIdRef.current = newClientAttemptId();
            }
            const clientAttemptId = clientAttemptIdRef.current;

            const request: SubmitTrainingAttemptRequest =
                phase === 'AWAITING_MOVE' &&
                attemptId &&
                nextStepIndex !== null
                    ? {
                          kind: 'STEP',
                          clientAttemptId,
                          attemptId,
                          stepIndex: nextStepIndex,
                          moveUci,
                          timeSpentMs: elapsed,
                      }
                    : {
                          kind: 'START',
                          clientAttemptId,
                          solutionRevisionId: prompt.solutionRevisionId,
                          moveUci,
                          timeSpentMs: elapsed,
                      };

            const submission: LastSubmission = {
                momentId: prompt.id,
                request,
                fenBefore,
                fenAfterMove,
            };
            lastSubmissionRef.current = submission;
            setPositionFen(fenAfterMove);
            setPhase('SUBMITTING');
            setResponse(null);
            setError(null);

            if (!online) {
                queueSubmission(submission);
                return;
            }

            try {
                const authoritative = await submitTrainingAttempt(
                    prompt.id,
                    request
                );
                applyResponse(authoritative, fenAfterMove);
            } catch (caught) {
                if (shouldQueue(caught)) {
                    setOnline(false);
                    queueSubmission(submission);
                    return;
                }
                setPositionFen(fenBefore);
                setPhase(phaseBeforeSubmission(request));
                setError(errorMessage(caught));
            }
        },
        [
            applyResponse,
            attemptId,
            nextStepIndex,
            online,
            phase,
            positionFen,
            prompt,
            queueSubmission,
        ]
    );

    const retryGrading = useCallback(async () => {
        const submission = lastSubmissionRef.current;
        if (
            !submission ||
            !attemptId ||
            phase !== 'UNRESOLVED'
        ) {
            return;
        }
        const stepIndex =
            submission.request.kind === 'START'
                ? 0
                : submission.request.stepIndex;
        const retrySubmission: LastSubmission = {
            ...submission,
            request: {
                kind: 'RETRY',
                clientAttemptId:
                    submission.request.clientAttemptId,
                attemptId,
                stepIndex,
                retryId: newClientAttemptId(),
            },
        };
        lastSubmissionRef.current = retrySubmission;
        setPhase('SUBMITTING');
        setError(null);
        try {
            const authoritative = await submitTrainingAttempt(
                retrySubmission.momentId,
                retrySubmission.request
            );
            applyResponse(
                authoritative,
                retrySubmission.fenAfterMove
            );
        } catch (caught) {
            if (shouldQueue(caught)) {
                setOnline(false);
                queueSubmission(retrySubmission);
                return;
            }
            setPhase('UNRESOLVED');
            setError(errorMessage(caught));
        }
    }, [applyResponse, attemptId, phase, queueSubmission]);

    const reveal = useCallback(async () => {
        if (
            !prompt ||
            !online ||
            !(
                phase === 'READY' ||
                phase === 'AWAITING_MOVE' ||
                phase === 'UNRESOLVED'
            )
        ) {
            return;
        }
        const previousPhase = phase;
        setPhase('REVEALING');
        setError(null);
        try {
            const revealed = await revealTrainingMoment(prompt.id, {
                clientAttemptId: newClientAttemptId(),
                solutionRevisionId: prompt.solutionRevisionId,
            });
            setResponse(revealed);
            setAttemptId(revealed.attemptId);
            setNextStepIndex(null);
            setPhase('REVEALED');
        } catch (caught) {
            setPhase(previousPhase);
            setError(errorMessage(caught));
        }
    }, [online, phase, prompt]);

    const flushQueue = useCallback(async () => {
        if (!ownerId || !online || flushInFlightRef.current) return;
        flushInFlightRef.current = true;
        try {
            const queued = readQueue(ownerId);
            const remainingEntries: QueuedTrainingAttempt[] = [];
            for (let index = 0; index < queued.length; index += 1) {
                const entry = queued[index];
                // A conditional response must be shown in the matching board
                // state. Never consume another moment's queued move in the
                // background and strand its continuation.
                if (entry.momentId !== prompt?.id) {
                    remainingEntries.push(entry);
                    continue;
                }
                try {
                    const authoritative = await submitTrainingAttempt(
                        entry.momentId,
                        entry.request
                    );
                    const isCurrent =
                        phase === 'PENDING_GRADING' &&
                        clientAttemptIdRef.current ===
                            entry.request.clientAttemptId;
                    if (isCurrent) {
                        applyResponse(
                            authoritative,
                            entry.fenAfterMove
                        );
                    }
                } catch (caught) {
                    if (keepQueued(caught)) {
                        remainingEntries.push(...queued.slice(index));
                        if (shouldQueue(caught)) setOnline(false);
                        break;
                    }
                    if (
                        prompt?.id === entry.momentId &&
                        phase === 'PENDING_GRADING'
                    ) {
                        setPositionFen(
                            entry.request.kind === 'RETRY'
                                ? entry.fenAfterMove
                                : entry.fenBefore
                        );
                        setPhase(
                            phaseBeforeSubmission(entry.request)
                        );
                        setError(errorMessage(caught));
                    }
                }
            }
            if (!writeQueue(ownerId, remainingEntries)) {
                setError(
                    'Pending moves were graded, but local queue cleanup failed.'
                );
            }
            setQueuedCount(remainingEntries.length);
        } finally {
            flushInFlightRef.current = false;
        }
    }, [applyResponse, online, ownerId, phase, prompt?.id]);

    useEffect(() => {
        if (online && queuedCount > 0) void flushQueue();
    }, [flushQueue, online, queuedCount]);

    const next = useCallback(async () => {
        if (advanceInFlightRef.current) return;
        advanceInFlightRef.current = true;
        try {
            if (
                loading ||
                phase === 'SUBMITTING' ||
                phase === 'REVEALING' ||
                phase === 'PENDING_GRADING' ||
                phase === 'AWAITING_MOVE'
            ) {
                return;
            }

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
                setPrompt(null);
                setPositionFen(null);
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
                    setPrompt(null);
                    setPositionFen(null);
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
        loading,
        phase,
        replaceBuffer,
        startFeedPageRequest,
    ]);

    const resetFeed = useCallback(
        (filters: PracticeFilters) => {
            if (initialMomentId) return;
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
            setPrompt(null);
            setPositionFen(null);
            replaceBuffer([]);
            setNextCursor(null);
            setFeedStarted(false);
            setAppliedFilters({});
            setFeedExhausted(false);
            setFeedHadPositions(false);
            setResponse(null);
            setAttemptId(null);
            setNextStepIndex(null);
            setError(null);
            clientAttemptIdRef.current = null;
            lastSubmissionRef.current = null;
            setFeedRequest((current) => ({
                filters,
                revision: current.revision + 1,
            }));
        },
        [initialMomentId, replaceBuffer]
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

    const grade =
        response?.status === 'GRADED'
            ? (response as GradedTrainingAttemptResponse).grade
            : null;
    const unresolved =
        response?.status === 'UNRESOLVED'
            ? {
                  reason: response.reason,
                  retryAfterMs: response.retryAfterMs ?? null,
              }
            : null;

    return {
        prompt,
        positionFen,
        phase,
        grade,
        unresolved,
        review: reviewFromAuthoritativeResponse(response),
        loading,
        feedExhausted,
        feedHadPositions,
        bufferedPositions: buffer.length,
        loadError,
        error,
        online,
        queuedCount,
        canMove: phase === 'READY' || phase === 'AWAITING_MOVE',
        canReveal:
            online &&
            (phase === 'READY' ||
                phase === 'AWAITING_MOVE' ||
                phase === 'UNRESOLVED'),
        submitMove,
        reveal,
        retryGrading,
        flushQueue,
        next,
        resetFeed,
        practiceFilters: feedRequest.filters,
        appliedPracticeFilters: appliedFilters,
        retryFeed,
    };
}
