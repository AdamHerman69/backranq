'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { StockfishClient } from '@/lib/analysis/stockfishClient';
import type {
    GradedPracticeResult,
    PracticeResult,
    RecordTrainingAttemptRequest,
    RecordedTrainingAttemptStepDto,
    RevealedPracticeResult,
    TrainingPromptDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import { newClientId } from '@/lib/training/clientIds';
import {
    aggregateTrainingGrade,
    gradeKnownLocalMove,
    gradeUnknownLocalMove,
    localContinuationForMove,
    type LocalMoveEvaluation,
} from '@/lib/training/localGrading';
import { buildPostMoveStory } from '@/lib/training/postMoveStory';
import {
    reviewFromTrainingResponse,
    type TrainerAttemptPhase,
} from '@/lib/training/trainerState';

type Submission = {
    node: TrainingSolutionTreeNodeDto;
    stepIndex: number;
    moveUci: string;
    timeSpentMs: number;
    fenBefore: string;
    fenAfterMove: string;
};

export type PuzzleSessionCompletion = {
    prompt: TrainingPromptDto;
    terminalReason: 'MOVE_SUBMITTED' | 'REVEALED';
    request: RecordTrainingAttemptRequest;
};

export type PuzzleSessionOptions = {
    initialPrompt?: TrainingPromptDto | null;
    unresolvedMode?: 'RETRY' | 'REVEAL';
    prewarmEngine?: boolean;
    stopEngineOnTerminal?: boolean;
    onCompleted?: (completion: PuzzleSessionCompletion) => void;
};

function gradingSource(
    steps: readonly RecordedTrainingAttemptStepDto[]
): 'PRECOMPUTED' | 'DYNAMIC' | 'TABLEBASE' {
    const sources = steps.flatMap((step) =>
        step.source ? [step.source] : []
    );
    if (sources.includes('DYNAMIC')) return 'DYNAMIC';
    if (sources.includes('TABLEBASE')) return 'TABLEBASE';
    return 'PRECOMPUTED';
}

export function usePuzzleSession(options: PuzzleSessionOptions = {}) {
    const [prompt, setPrompt] = useState<TrainingPromptDto | null>(
        options.initialPrompt ?? null
    );
    const [solveFen, setSolveFen] = useState<string | null>(
        options.initialPrompt?.fen ?? null
    );
    const [displayFen, setDisplayFen] = useState<string | null>(
        options.initialPrompt?.fen ?? null
    );
    const [phase, setPhase] =
        useState<TrainerAttemptPhase>('READY');
    const [response, setResponse] = useState<
        PracticeResult | RevealedPracticeResult | null
    >(null);
    const [reviewFallback, setReviewFallback] = useState(false);
    const [presentationSettled, setPresentationSettled] = useState(true);
    const [engineClient, setEngineClient] =
        useState<StockfishClient | null>(null);

    const promptRef = useRef<TrainingPromptDto | null>(
        options.initialPrompt ?? null
    );
    const currentNodeRef = useRef<TrainingSolutionTreeNodeDto | null>(
        options.initialPrompt?.grading.solutionTree ?? null
    );
    const stepsRef = useRef<RecordedTrainingAttemptStepDto[]>([]);
    const lastSubmissionRef = useRef<Submission | null>(null);
    const clientAttemptIdRef = useRef<string | null>(null);
    const promptStartedAtRef = useRef(Date.now());
    const engineRef = useRef<StockfishClient | null>(null);
    const generationRef = useRef(0);
    const moveSubmissionInFlightRef = useRef(false);
    const gradingInFlightRef = useRef(false);
    const onCompletedRef = useRef(options.onCompleted);
    onCompletedRef.current = options.onCompleted;

    const getOrCreateEngine = useCallback(() => {
        if (engineRef.current) return engineRef.current;
        const engine = new StockfishClient();
        engineRef.current = engine;
        setEngineClient(engine);
        return engine;
    }, []);

    const stopEngine = useCallback(() => {
        engineRef.current?.terminate();
        engineRef.current = null;
        setEngineClient(null);
    }, []);

    const activatePrompt = useCallback((next: TrainingPromptDto) => {
        generationRef.current += 1;
        promptRef.current = next;
        currentNodeRef.current = next.grading.solutionTree;
        stepsRef.current = [];
        lastSubmissionRef.current = null;
        clientAttemptIdRef.current = null;
        moveSubmissionInFlightRef.current = false;
        gradingInFlightRef.current = false;
        promptStartedAtRef.current = Date.now();
        setPrompt(next);
        setSolveFen(next.fen);
        setDisplayFen(next.fen);
        setPhase('READY');
        setResponse(null);
        setReviewFallback(false);
        setPresentationSettled(true);
    }, []);

    const clearPrompt = useCallback(() => {
        generationRef.current += 1;
        promptRef.current = null;
        currentNodeRef.current = null;
        stepsRef.current = [];
        lastSubmissionRef.current = null;
        clientAttemptIdRef.current = null;
        moveSubmissionInFlightRef.current = false;
        gradingInFlightRef.current = false;
        setPrompt(null);
        setSolveFen(null);
        setDisplayFen(null);
        setPhase('READY');
        setResponse(null);
        setReviewFallback(false);
        setPresentationSettled(true);
    }, []);

    useEffect(() => {
        if (!options.prewarmEngine || !prompt || engineRef.current) return;
        const timeoutId = window.setTimeout(() => {
            try {
                const engine = getOrCreateEngine();
                void engine.getIdentity().catch(() => {
                    if (engineRef.current === engine) {
                        stopEngine();
                    }
                });
            } catch {
                // Unknown moves can retry engine creation when submitted.
            }
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [getOrCreateEngine, options.prewarmEngine, prompt, stopEngine]);

    useEffect(
        () => () => {
            generationRef.current += 1;
            engineRef.current?.terminate();
            engineRef.current = null;
        },
        []
    );

    const revealAfterUnresolved = useCallback(
        (submission: Submission, comparison: LocalMoveEvaluation['comparison']) => {
            const activePrompt = promptRef.current;
            if (!activePrompt) return;
            const clientAttemptId =
                clientAttemptIdRef.current ?? newClientId();
            clientAttemptIdRef.current = clientAttemptId;
            const revealed: RevealedPracticeResult = {
                attemptId: clientAttemptId,
                status: 'REVEALED',
                review: {
                    ...activePrompt.grading.review,
                    submittedMoveUci: submission.moveUci,
                    comparison,
                },
            };
            setResponse(revealed);
            setSolveFen(submission.fenAfterMove);
            setDisplayFen(activePrompt.fen);
            setReviewFallback(true);
            setPhase('REVEALED');
            setPresentationSettled(true);
            if (options.stopEngineOnTerminal) stopEngine();
        },
        [options.stopEngineOnTerminal, stopEngine]
    );

    const applyEvaluation = useCallback(
        (evaluation: LocalMoveEvaluation, submission: Submission) => {
            const activePrompt = promptRef.current;
            if (!activePrompt || !clientAttemptIdRef.current) return;
            if (evaluation.result.status === 'UNRESOLVED') {
                if (options.unresolvedMode === 'REVEAL') {
                    revealAfterUnresolved(submission, evaluation.comparison);
                    return;
                }
                setResponse({
                    attemptId: clientAttemptIdRef.current,
                    status: 'UNRESOLVED',
                    reason: evaluation.result.reason,
                });
                setSolveFen(submission.fenAfterMove);
                setDisplayFen(submission.fenAfterMove);
                setPhase('UNRESOLVED');
                setPresentationSettled(true);
                return;
            }

            setReviewFallback(false);
            const userStep: RecordedTrainingAttemptStepDto = {
                stepIndex: submission.stepIndex,
                actor: 'USER',
                fenBefore: submission.fenBefore,
                moveUci: submission.moveUci,
                grade: evaluation.result.grade,
                source: evaluation.source,
                comparison: evaluation.comparison,
                timeSpentMs: submission.timeSpentMs,
            };
            const stepsWithUser = [...stepsRef.current, userStep];
            const continuation = evaluation.result.accepted
                ? localContinuationForMove({
                      node: submission.node,
                      moveUci: submission.moveUci,
                  })
                : null;
            if (continuation) {
                stepsRef.current = [
                    ...stepsWithUser,
                    {
                        stepIndex: submission.stepIndex + 1,
                        actor: 'ENGINE',
                        fenBefore: submission.fenAfterMove,
                        moveUci: continuation.opponentMoveUci,
                    },
                ];
                currentNodeRef.current = continuation.nextUserNode;
                moveSubmissionInFlightRef.current = false;
                setResponse({
                    attemptId: clientAttemptIdRef.current,
                    status: 'AWAITING_CONTINUATION',
                    nextStepIndex: submission.stepIndex + 2,
                    opponentMove: {
                        moveUci: continuation.opponentMoveUci,
                        fenAfter: continuation.fenAfterOpponentMove,
                    },
                });
                setSolveFen(continuation.fenAfterOpponentMove);
                setDisplayFen(continuation.fenAfterOpponentMove);
                setPhase('AWAITING_MOVE');
                setPresentationSettled(true);
                promptStartedAtRef.current = Date.now();
                return;
            }

            stepsRef.current = stepsWithUser;
            const userSteps = stepsWithUser.filter(
                (step) => step.actor === 'USER'
            );
            const grade = aggregateTrainingGrade(
                userSteps.flatMap((step) => (step.grade ? [step.grade] : []))
            );
            const comparison =
                userSteps.length === 1 ? evaluation.comparison : null;
            const graded: GradedPracticeResult = {
                attemptId: clientAttemptIdRef.current,
                status: 'GRADED',
                grade,
                accepted:
                    grade === 'BEST' ||
                    grade === 'STRONG' ||
                    grade === 'GOOD',
                review: {
                    ...activePrompt.grading.review,
                    submittedMoveUci: userSteps[0]?.moveUci ?? null,
                    comparison,
                },
            };
            setResponse(graded);
            setSolveFen(submission.fenAfterMove);
            setDisplayFen(activePrompt.fen);
            setPhase('GRADED');
            setPresentationSettled(true);
            onCompletedRef.current?.({
                prompt: activePrompt,
                terminalReason: 'MOVE_SUBMITTED',
                request: {
                    kind: 'RECORD',
                    clientAttemptId: clientAttemptIdRef.current,
                    solutionRevisionId: activePrompt.solutionRevisionId,
                    status: 'GRADED',
                    grade,
                    gradingSource: gradingSource(userSteps),
                    comparison,
                    steps: stepsWithUser,
                },
            });
            if (options.stopEngineOnTerminal) stopEngine();
        },
        [
            options.stopEngineOnTerminal,
            options.unresolvedMode,
            revealAfterUnresolved,
            stopEngine,
        ]
    );

    const submitMove = useCallback(
        async ({
            moveUci,
            fenAfterMove,
        }: {
            moveUci: string;
            fenAfterMove: string;
        }) => {
            const activePrompt = promptRef.current;
            const node = currentNodeRef.current;
            if (
                !activePrompt ||
                !solveFen ||
                !node ||
                node.role !== 'USER' ||
                moveSubmissionInFlightRef.current ||
                (phase !== 'READY' && phase !== 'AWAITING_MOVE')
            ) {
                return;
            }
            moveSubmissionInFlightRef.current = true;
            const generation = generationRef.current;
            clientAttemptIdRef.current ??= newClientId();
            const submission: Submission = {
                node,
                stepIndex: stepsRef.current.length,
                moveUci,
                timeSpentMs: Math.max(
                    0,
                    Math.min(Date.now() - promptStartedAtRef.current, 86_400_000)
                ),
                fenBefore: solveFen,
                fenAfterMove,
            };
            lastSubmissionRef.current = submission;
            setSolveFen(fenAfterMove);
            setDisplayFen(fenAfterMove);
            setResponse(null);
            setReviewFallback(false);

            const known = gradeKnownLocalMove({
                manifest: activePrompt.grading,
                node,
                moveUci,
            });
            if (known) {
                applyEvaluation(known, submission);
                return;
            }

            setPhase('SUBMITTING');
            gradingInFlightRef.current = true;
            try {
                const evaluated = await gradeUnknownLocalMove({
                    engine: getOrCreateEngine(),
                    manifest: activePrompt.grading,
                    node,
                    moveUci,
                    positionHistory: [
                        ...activePrompt.grading.positionHistory,
                        ...stepsRef.current.map((step) => step.fenBefore),
                    ],
                });
                if (generationRef.current !== generation) return;
                applyEvaluation(evaluated, submission);
            } catch {
                if (generationRef.current !== generation) return;
                stopEngine();
                if (options.unresolvedMode === 'REVEAL') {
                    revealAfterUnresolved(submission, null);
                    return;
                }
                setResponse({
                    attemptId: clientAttemptIdRef.current,
                    status: 'UNRESOLVED',
                    reason: 'ENGINE_UNAVAILABLE',
                });
                setPhase('UNRESOLVED');
                setPresentationSettled(true);
            } finally {
                if (generationRef.current === generation) {
                    gradingInFlightRef.current = false;
                }
            }
        },
        [
            applyEvaluation,
            getOrCreateEngine,
            options.unresolvedMode,
            phase,
            revealAfterUnresolved,
            solveFen,
            stopEngine,
        ]
    );

    const retryGrading = useCallback(async () => {
        const activePrompt = promptRef.current;
        const submission = lastSubmissionRef.current;
        if (
            !activePrompt ||
            !submission ||
            phase !== 'UNRESOLVED' ||
            gradingInFlightRef.current
        ) {
            return;
        }
        const generation = generationRef.current;
        gradingInFlightRef.current = true;
        setPhase('SUBMITTING');
        try {
            const evaluated = await gradeUnknownLocalMove({
                engine: getOrCreateEngine(),
                manifest: activePrompt.grading,
                node: submission.node,
                moveUci: submission.moveUci,
                positionHistory: [
                    ...activePrompt.grading.positionHistory,
                    ...stepsRef.current.map((step) => step.fenBefore),
                ],
            });
            if (generationRef.current !== generation) return;
            applyEvaluation(evaluated, submission);
        } catch {
            if (generationRef.current === generation) {
                stopEngine();
                setPhase('UNRESOLVED');
            }
        } finally {
            if (generationRef.current === generation) {
                gradingInFlightRef.current = false;
            }
        }
    }, [applyEvaluation, getOrCreateEngine, phase, stopEngine]);

    const reveal = useCallback(() => {
        const activePrompt = promptRef.current;
        if (
            !activePrompt ||
            !(
                phase === 'READY' ||
                phase === 'AWAITING_MOVE' ||
                phase === 'UNRESOLVED'
            ) ||
            gradingInFlightRef.current ||
            (moveSubmissionInFlightRef.current && phase !== 'UNRESOLVED')
        ) {
            return;
        }
        moveSubmissionInFlightRef.current = true;
        const clientAttemptId =
            clientAttemptIdRef.current ?? newClientId();
        clientAttemptIdRef.current = clientAttemptId;
        const firstSubmittedMove =
            stepsRef.current.find((step) => step.actor === 'USER')?.moveUci ??
            lastSubmissionRef.current?.moveUci ??
            null;
        const revealed: RevealedPracticeResult = {
            attemptId: clientAttemptId,
            status: 'REVEALED',
            review: {
                ...activePrompt.grading.review,
                submittedMoveUci: firstSubmittedMove,
                comparison: null,
            },
        };
        setResponse(revealed);
        setDisplayFen(activePrompt.fen);
        setReviewFallback(false);
        setPhase('REVEALED');
        setPresentationSettled(true);
        onCompletedRef.current?.({
            prompt: activePrompt,
            terminalReason: 'REVEALED',
            request: {
                kind: 'RECORD',
                clientAttemptId,
                solutionRevisionId: activePrompt.solutionRevisionId,
                status: 'REVEALED',
                steps: stepsRef.current,
            },
        });
        if (options.stopEngineOnTerminal) stopEngine();
    }, [options.stopEngineOnTerminal, phase, stopEngine]);

    const grade =
        response?.status === 'GRADED'
            ? (response as GradedPracticeResult).grade
            : null;
    const review = reviewFromTrainingResponse(response);
    const story = useMemo(
        () =>
            prompt && review
                ? buildPostMoveStory({ prompt, review, grade })
                : null,
        [grade, prompt, review]
    );
    const attemptTerminal = phase === 'GRADED' || phase === 'REVEALED';
    const beginPresentation = useCallback(
        () => setPresentationSettled(false),
        []
    );
    const settlePresentation = useCallback(
        () => setPresentationSettled(true),
        []
    );

    return {
        prompt,
        positionFen: solveFen,
        solveFen,
        displayFen,
        phase,
        grade,
        unresolved:
            response?.status === 'UNRESOLVED'
                ? { reason: response.reason }
                : null,
        review,
        reviewFallback,
        story,
        attemptTerminal,
        presentationSettled,
        terminal: attemptTerminal && presentationSettled,
        engineClient,
        canMove: phase === 'READY' || phase === 'AWAITING_MOVE',
        canReveal:
            phase === 'READY' ||
            phase === 'AWAITING_MOVE' ||
            phase === 'UNRESOLVED',
        activatePrompt,
        clearPrompt,
        getOrCreateEngine,
        stopEngine,
        submitMove,
        retryGrading,
        reveal,
        beginPresentation,
        settlePresentation,
    };
}
