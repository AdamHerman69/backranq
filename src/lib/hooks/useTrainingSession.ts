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
    RevealTrainingMomentResponse,
    SubmitTrainingAttemptRequest,
    SubmitTrainingAttemptResponse,
    TrainingPromptDto,
    TrainingSessionFilters,
} from '@/lib/training/api';
import {
    fetchTrainingMoment,
    fetchTrainingSession,
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

const SESSION_BATCH_SIZE = 12;

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

export function useTrainingSession(
    initialMomentId?: string,
    ownerIdOverride?: string
) {
    const { data: session } = useSession();
    const ownerId = ownerIdOverride ?? session?.user?.id ?? null;

    const [prompt, setPrompt] = useState<TrainingPromptDto | null>(null);
    const [remaining, setRemaining] = useState<TrainingPromptDto[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [sessionStarted, setSessionStarted] = useState(false);
    const [paginationFilters, setPaginationFilters] =
        useState<TrainingSessionFilters>({});
    const [sessionRequest, setSessionRequest] = useState<{
        filters: TrainingSessionFilters;
        revision: number;
    }>({ filters: {}, revision: 0 });
    const [loading, setLoading] = useState(true);
    const [sessionComplete, setSessionComplete] = useState(false);
    const [sessionHadItems, setSessionHadItems] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [positionFen, setPositionFen] = useState<string | null>(null);
    const [phase, setPhase] = useState<TrainerAttemptPhase>('READY');
    const [response, setResponse] = useState<
        SubmitTrainingAttemptResponse | RevealTrainingMomentResponse | null
    >(null);
    const [attemptId, setAttemptId] = useState<string | null>(null);
    const [nextStepIndex, setNextStepIndex] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [online, setOnline] = useState(
        () => typeof navigator === 'undefined' || navigator.onLine
    );
    const [queuedCount, setQueuedCount] = useState(0);

    const clientAttemptIdRef = useRef<string | null>(null);
    const promptStartedAtRef = useRef(Date.now());
    const lastSubmissionRef = useRef<LastSubmission | null>(null);
    const flushInFlightRef = useRef(false);

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
            setSessionComplete(false);
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

    const loadInitial = useCallback(
        async (signal?: AbortSignal) => {
            setLoading(true);
            setLoadError(null);
            try {
                if (initialMomentId) {
                    const detail = await fetchTrainingMoment(
                        initialMomentId,
                        signal
                    );
                    if (signal?.aborted) return;
                    setRemaining([]);
                    setNextCursor(null);
                    setPaginationFilters({});
                    setSessionStarted(false);
                    setSessionHadItems(true);
                    activatePrompt(detail.moment);
                    return;
                }

                const result = await fetchTrainingSession(
                    {
                        limit: SESSION_BATCH_SIZE,
                        filters: sessionRequest.filters,
                    },
                    signal
                );
                if (signal?.aborted) return;
                setSessionStarted(true);
                setNextCursor(result.nextCursor);
                setPaginationFilters(result.appliedFilters);
                const [first, ...rest] = result.items;
                setSessionHadItems(Boolean(first));
                setRemaining(rest);
                if (first) {
                    activatePrompt(first);
                } else {
                    setPrompt(null);
                    setPositionFen(null);
                    setSessionComplete(true);
                }
            } catch (caught) {
                if (signal?.aborted) return;
                setLoadError(errorMessage(caught));
                setPrompt(null);
                setPositionFen(null);
            } finally {
                if (!signal?.aborted) setLoading(false);
            }
        },
        [activatePrompt, initialMomentId, sessionRequest]
    );

    useEffect(() => {
        const controller = new AbortController();
        void loadInitial(controller.signal);
        return () => controller.abort();
    }, [loadInitial]);

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
        if (
            loading ||
            phase === 'SUBMITTING' ||
            phase === 'REVEALING' ||
            phase === 'PENDING_GRADING' ||
            phase === 'AWAITING_MOVE'
        ) {
            return;
        }

        const [first, ...rest] = remaining;
        if (first) {
            setRemaining(rest);
            activatePrompt(first);
            return;
        }

        if (sessionStarted && nextCursor === null) {
            setPrompt(null);
            setPositionFen(null);
            setSessionComplete(true);
            return;
        }

        setLoading(true);
        setLoadError(null);
        try {
            const result = await fetchTrainingSession({
                limit: SESSION_BATCH_SIZE,
                cursor: sessionStarted ? nextCursor ?? undefined : undefined,
                filters: paginationFilters,
            });
            setSessionStarted(true);
            setNextCursor(result.nextCursor);
            setPaginationFilters(result.appliedFilters);
            const filtered = result.items.filter(
                (item) => item.id !== prompt?.id
            );
            const [nextPrompt, ...restPrompts] = filtered;
            setRemaining(restPrompts);
            if (nextPrompt) {
                setSessionHadItems(true);
                activatePrompt(nextPrompt);
            } else {
                setPrompt(null);
                setPositionFen(null);
                setSessionComplete(true);
            }
        } catch (caught) {
            setLoadError(errorMessage(caught));
        } finally {
            setLoading(false);
        }
    }, [
        activatePrompt,
        loading,
        nextCursor,
        phase,
        paginationFilters,
        prompt?.id,
        remaining,
        sessionStarted,
    ]);

    const restartSession = useCallback(
        (filters: TrainingSessionFilters) => {
            if (initialMomentId) return;
            setLoading(true);
            setLoadError(null);
            setPrompt(null);
            setPositionFen(null);
            setRemaining([]);
            setNextCursor(null);
            setSessionStarted(false);
            setPaginationFilters({});
            setSessionComplete(false);
            setSessionHadItems(false);
            setResponse(null);
            setAttemptId(null);
            setNextStepIndex(null);
            setError(null);
            clientAttemptIdRef.current = null;
            lastSubmissionRef.current = null;
            setSessionRequest((current) => ({
                filters,
                revision: current.revision + 1,
            }));
        },
        [initialMomentId]
    );

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
        sessionComplete,
        sessionHadItems,
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
        restartSession,
        sessionFilters: sessionRequest.filters,
        retryLoad: () => loadInitial(),
    };
}
