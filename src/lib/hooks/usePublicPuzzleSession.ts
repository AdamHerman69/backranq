'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { StockfishClient } from '@/lib/analysis/stockfishClient';
import type {
    GradedPracticeResult,
    PracticeResult,
    RecordedTrainingAttemptStepDto,
    RevealedPracticeResult,
    TrainingPromptDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import {
    aggregateTrainingGrade,
    gradeKnownLocalMove,
    gradeUnknownLocalMove,
    localContinuationForMove,
    type LocalMoveEvaluation,
} from '@/lib/training/localGrading';
import { publicPuzzleReviewFallback } from '@/lib/onboarding/publicPuzzleGrading';
import {
    reviewFromTrainingResponse,
    type TrainerAttemptPhase,
} from '@/lib/training/trainerState';

type Submission = {
    node: TrainingSolutionTreeNodeDto;
    stepIndex: number;
    moveUci: string;
    fenBefore: string;
    fenAfterMove: string;
};

export function usePublicPuzzleSession(prompt: TrainingPromptDto) {
    const [positionFen, setPositionFen] = useState(prompt.fen);
    const [phase, setPhase] = useState<TrainerAttemptPhase>('READY');
    const [response, setResponse] = useState<
        PracticeResult | RevealedPracticeResult | null
    >(null);
    const [reviewFallback, setReviewFallback] = useState(false);
    const currentNodeRef = useRef<TrainingSolutionTreeNodeDto>(
        prompt.grading.solutionTree
    );
    const stepsRef = useRef<RecordedTrainingAttemptStepDto[]>([]);
    const lastSubmissionRef = useRef<Submission | null>(null);
    const engineRef = useRef<StockfishClient | null>(null);
    const generationRef = useRef(0);

    const getOrCreateEngine = useCallback(() => {
        if (engineRef.current) return engineRef.current;
        const engine = new StockfishClient();
        engineRef.current = engine;
        return engine;
    }, []);

    const stopEngine = useCallback(() => {
        engineRef.current?.terminate();
        engineRef.current = null;
    }, []);

    useEffect(
        () => () => {
            generationRef.current += 1;
            stopEngine();
        },
        [stopEngine]
    );

    const applyEvaluation = useCallback(
        (evaluation: LocalMoveEvaluation, submission: Submission) => {
            if (evaluation.result.status === 'UNRESOLVED') {
                setResponse(
                    publicPuzzleReviewFallback({
                        review: prompt.grading.review,
                        submittedMoveUci: submission.moveUci,
                        comparison: evaluation.comparison,
                    })
                );
                setPositionFen(submission.fenAfterMove);
                setReviewFallback(true);
                setPhase('REVEALED');
                stopEngine();
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
            };
            const nextSteps = [...stepsRef.current, userStep];
            const continuation = evaluation.result.accepted
                ? localContinuationForMove({
                      node: submission.node,
                      moveUci: submission.moveUci,
                  })
                : null;
            if (continuation) {
                stepsRef.current = [
                    ...nextSteps,
                    {
                        stepIndex: submission.stepIndex + 1,
                        actor: 'ENGINE',
                        fenBefore: submission.fenAfterMove,
                        moveUci: continuation.opponentMoveUci,
                    },
                ];
                currentNodeRef.current = continuation.nextUserNode;
                setResponse({
                    attemptId: 'public-local',
                    status: 'AWAITING_CONTINUATION',
                    nextStepIndex: submission.stepIndex + 2,
                    opponentMove: {
                        moveUci: continuation.opponentMoveUci,
                        fenAfter: continuation.fenAfterOpponentMove,
                    },
                });
                setPositionFen(continuation.fenAfterOpponentMove);
                setPhase('AWAITING_MOVE');
                return;
            }

            stepsRef.current = nextSteps;
            const userSteps = nextSteps.filter((step) => step.actor === 'USER');
            const grade = aggregateTrainingGrade(
                userSteps.flatMap((step) => (step.grade ? [step.grade] : []))
            );
            setResponse({
                attemptId: 'public-local',
                status: 'GRADED',
                grade,
                accepted:
                    grade === 'BEST' ||
                    grade === 'STRONG' ||
                    grade === 'GOOD',
                review: {
                    ...prompt.grading.review,
                    submittedMoveUci: userSteps[0]?.moveUci ?? null,
                    comparison:
                        userSteps.length === 1 ? evaluation.comparison : null,
                },
            });
            setPositionFen(submission.fenAfterMove);
            setPhase('GRADED');
            stopEngine();
        },
        [prompt.grading.review, stopEngine]
    );

    const submitMove = useCallback(
        async ({
            moveUci,
            fenAfterMove,
        }: {
            moveUci: string;
            fenAfterMove: string;
        }) => {
            const node = currentNodeRef.current;
            if (
                node.role !== 'USER' ||
                (phase !== 'READY' && phase !== 'AWAITING_MOVE')
            ) {
                return;
            }
            const generation = generationRef.current;
            const submission: Submission = {
                node,
                stepIndex: stepsRef.current.length,
                moveUci,
                fenBefore: positionFen,
                fenAfterMove,
            };
            lastSubmissionRef.current = submission;
            setPositionFen(fenAfterMove);
            setResponse(null);
            setReviewFallback(false);

            const known = gradeKnownLocalMove({
                manifest: prompt.grading,
                node,
                moveUci,
            });
            if (known) {
                applyEvaluation(known, submission);
                return;
            }

            setPhase('SUBMITTING');
            try {
                const evaluation = await gradeUnknownLocalMove({
                    engine: getOrCreateEngine(),
                    manifest: prompt.grading,
                    node,
                    moveUci,
                    positionHistory: [
                        ...prompt.grading.positionHistory,
                        ...stepsRef.current.map((step) => step.fenBefore),
                    ],
                });
                if (generationRef.current !== generation) return;
                applyEvaluation(evaluation, submission);
            } catch {
                if (generationRef.current !== generation) return;
                setResponse(
                    publicPuzzleReviewFallback({
                        review: prompt.grading.review,
                        submittedMoveUci: submission.moveUci,
                    })
                );
                setReviewFallback(true);
                setPhase('REVEALED');
                stopEngine();
            }
        },
        [
            applyEvaluation,
            getOrCreateEngine,
            phase,
            positionFen,
            prompt.grading,
            stopEngine,
        ]
    );

    const reveal = useCallback(() => {
        if (phase !== 'READY' && phase !== 'AWAITING_MOVE') {
            return;
        }
        const firstMove =
            stepsRef.current.find((step) => step.actor === 'USER')?.moveUci ??
            lastSubmissionRef.current?.moveUci ??
            null;
        setResponse({
            attemptId: 'public-local',
            status: 'REVEALED',
            review: {
                ...prompt.grading.review,
                submittedMoveUci: firstMove,
                comparison: null,
            },
        });
        setReviewFallback(false);
        setPhase('REVEALED');
        stopEngine();
    }, [phase, prompt.grading.review, stopEngine]);

    const grade =
        response?.status === 'GRADED'
            ? (response as GradedPracticeResult).grade
            : null;

    return {
        prompt,
        positionFen,
        phase,
        grade,
        review: reviewFromTrainingResponse(response),
        reviewFallback,
        canMove: phase === 'READY' || phase === 'AWAITING_MOVE',
        canReveal: phase === 'READY' || phase === 'AWAITING_MOVE',
        terminal:
            phase === 'GRADED' || phase === 'REVEALED',
        getOrCreateEngine,
        submitMove,
        reveal,
    };
}
