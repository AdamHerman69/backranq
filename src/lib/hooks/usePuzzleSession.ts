'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { AnalysisWorkPlanner } from '@/lib/analysis/analysisWorkPlanner';
import type { GradedPracticeResult, PracticeResult, RecordTrainingAttemptRequest, EnrichTrainingAttemptRequest,
    RevealedPracticeResult, TrainingPromptDto, TrainingReviewDto, TrainingSolutionTreeNodeDto } from '@/lib/training/api';
import { newClientId } from '@/lib/training/clientIds';
import { createLocalAnalysisSession, gradeKnownLocalMove, gradeUnknownLocalMove, localContinuationForMove, prewarmLocalReference,
    type LocalMoveEvaluation, type LocalGradingUpdate } from '@/lib/training/localGrading';
import { buildPostMoveStory } from '@/lib/training/postMoveStory';
import { boardPresentationReducer, initialBoardPresentation } from '@/lib/training/boardPresentation';
import { reviewFromTrainingResponse, type TrainerAttemptPhase } from '@/lib/training/trainerState';
import type { PovScore } from '@/lib/training/contracts';
import { lookupAnswer, observedAnswerRank } from '@/lib/training/answerIndex';
import type { PracticeMomentRevision, Tier } from '@/lib/training/practiceContract';
import { practiceScoreToWhitePov, referenceProjectionForPracticeComparison } from '@/lib/training/practiceReview';

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
    onRefined?: (prompt: TrainingPromptDto, request: EnrichTrainingAttemptRequest) => void;
    onCompleted?: (completion: PuzzleSessionCompletion) => void;
};
type Submission = { node: TrainingSolutionTreeNodeDto; stepIndex: number; moveUci: string; fenAfterMove: string;
    sequenceId: number; generation: number; attemptId: string; prompt: TrainingPromptDto; eventSequence: number;
    lastEventId: string | null; lastEvaluationKey: string | null; lastSupportedQuality: 'GOOD' | 'BELOW_STANDARD' | null; followedRecommendation: boolean };
function rootNode(prompt: TrainingPromptDto | null): TrainingSolutionTreeNodeDto | null {
    const node = prompt?.grading.continuation.nodes.find(item => item.contextId === prompt.grading.source.contextId && item.role === 'USER');
    if (node) return { ...node, ply: 0 };
    if (!prompt) return null;
    const source = prompt.grading.source;
    return { id: source.contextId, contextId: source.contextId, fen: source.fen, positionHistory: source.positionHistory,
        trainingSide: source.trainingSide, role: 'USER', answerIndex: prompt.grading.rootAnswerIndex, ply: 0 };
}
export function reviewWithLocalReference(review: TrainingReviewDto, evaluation: LocalMoveEvaluation, decisionIndex: number, manifest: PracticeMomentRevision): TrainingReviewDto {
    if (decisionIndex !== 0 || !evaluation.patch) return review;
    const patch = evaluation.patch;
    const reference = patch.assessments.find(item => item.id === patch.frame.referenceAssessmentId);
    if (!reference) return review;
    // The grading path already validated immutable patch conflicts. Merge raw
    // records here so paid-only root evidence and physical sequences survive.
    const evidence = { searches: { ...manifest.evidence.searches, ...patch.evidence.searches },
        observations: { ...manifest.evidence.observations, ...patch.evidence.observations },
        exact: { ...manifest.evidence.exact, ...patch.evidence.exact } };
    const projection = referenceProjectionForPracticeComparison({ assessment: evaluation.assessment, reference,
        frame: patch.frame, evidence, legalMovesUci: manifest.rootAnswerIndex.legalMovesUci,
        trainingSide: manifest.source.trainingSide, referenceMoveUci: reference.moveUci });
    const pv = projection.pvUci ?? (reference.moveUci === review.bestMoveUci ? review.bestLineUci : [reference.moveUci]);
    return { ...review, bestMoveUci: reference.moveUci, bestLineUci: pv, scoreAtStart: practiceScoreToWhitePov(projection.score),
        acceptedMovesUci: patch.assessments.filter(item => item.quality === 'GOOD' && item.qualitySupport === 'SUPPORTED').map(item => item.moveUci), acceptedMovesComplete: false };
}

export function usePuzzleSession(options: PuzzleSessionOptions = {}) {
    const [prompt, setPrompt] = useState<TrainingPromptDto | null>(options.initialPrompt ?? null);
    const [solveFen, setSolveFen] = useState<string | null>(options.initialPrompt?.fen ?? null);
    const [displayFen, setDisplayFen] = useState<string | null>(options.initialPrompt?.fen ?? null);
    const [phase, setPhase] = useState<TrainerAttemptPhase>('READY');
    const [response, setResponse] = useState<PracticeResult | RevealedPracticeResult | null>(null);
    const [reviewFallback, setReviewFallback] = useState(false);
    const [presentationSettled, setPresentationSettled] = useState(true);
    const [presentation, dispatchPresentation] = useReducer(boardPresentationReducer, undefined, () => initialBoardPresentation());
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);
    const [liveEvaluation, setLiveEvaluation] = useState<{ score: PovScore; depth: number } | null>(null);
    const [answerHint, setAnswerHint] = useState<string | null>(null);
    const [recommendationCreditRetained, setRecommendationCreditRetained] = useState(false);
    const promptRef = useRef(prompt);
    const nodeRef = useRef(rootNode(prompt));
    const engineRef = useRef<StockfishClient | null>(null);
    const generationRef = useRef(0);
    const sequenceRef = useRef(0);
    const attemptIdRef = useRef<string | null>(null);
    const userStepIndexRef = useRef(0);
    const startedAt = useRef(Date.now());
    const locked = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const prewarmAbortRef = useRef<AbortController | null>(null);
    const prewarmWorkRef = useRef<Promise<void> | null>(null);
    const plannerRef = useRef<AnalysisWorkPlanner | null>(null);
    const analysisRef = useRef(createLocalAnalysisSession());
    const submissionRef = useRef<Submission | null>(null);
    const rootReviewRef = useRef<TrainingReviewDto | null>(null);
    const rootGradeRef = useRef<Tier | null>(null);
    const reviewPositionRef = useRef<'DECISION' | 'ATTEMPT' | null>(null);
    const onCompleted = useRef(options.onCompleted); onCompleted.current = options.onCompleted;
    const onRefined = useRef(options.onRefined); onRefined.current = options.onRefined;

    const getOrCreateEngine = useCallback(() => {
        if (engineRef.current) return engineRef.current;
        const engine = new StockfishClient(); engineRef.current = engine; setEngineClient(engine); return engine;
    }, []);
    const stopEngine = useCallback(() => {
        engineRef.current?.terminate(); engineRef.current = null; setEngineClient(null);
    }, []);
    const reset = useCallback((next: TrainingPromptDto | null) => {
        generationRef.current += 1;
        abortRef.current?.abort(); plannerRef.current?.cancelGeneration();
        prewarmAbortRef.current?.abort(); prewarmWorkRef.current = null;
        engineRef.current?.cancelAll();
        analysisRef.current = createLocalAnalysisSession(); plannerRef.current = null;
        promptRef.current = next; nodeRef.current = rootNode(next); attemptIdRef.current = null;
        submissionRef.current = null; rootReviewRef.current = null; rootGradeRef.current = null; reviewPositionRef.current = null; userStepIndexRef.current = 0; locked.current = false; startedAt.current = Date.now();
        setPrompt(next); setSolveFen(next?.fen ?? null); setDisplayFen(next?.fen ?? null);
        setPhase('READY'); setResponse(null); setReviewFallback(false); setLiveEvaluation(null); setPresentationSettled(true);
        setAnswerHint(null);
        setRecommendationCreditRetained(false);
        dispatchPresentation({ type: 'RESET', sequenceId: ++sequenceRef.current });
    }, []);
    const activatePrompt = useCallback((next: TrainingPromptDto, transferredEngine?: StockfishClient | null) => {
        reset(next);
        if (transferredEngine && engineRef.current !== transferredEngine) {
            engineRef.current?.terminate();
            engineRef.current = transferredEngine; setEngineClient(transferredEngine);
        }
    }, [reset]);
    const clearPrompt = useCallback(() => reset(null), [reset]);

    useEffect(() => {
        if (!options.prewarmEngine || !prompt || document.hidden) return;
        const generation = generationRef.current;
        const onVisibility = () => { if (document.hidden) prewarmAbortRef.current?.abort(); };
        document.addEventListener('visibilitychange', onVisibility);
        const timer = window.setTimeout(() => {
            if (generation !== generationRef.current || document.hidden) return;
            try {
                const engine = getOrCreateEngine();
                void engine.getIdentity().catch(() => undefined);
                const node = nodeRef.current;
                if (node) {
                    const abort = new AbortController(); prewarmAbortRef.current = abort;
                    prewarmWorkRef.current = prewarmLocalReference({ engine, manifest: prompt.grading, node, session: analysisRef.current, signal: abort.signal });
                }
            } catch { /* A played move can retry startup. */ }
        }, 0);
        return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); prewarmAbortRef.current?.abort(); };
    }, [getOrCreateEngine, options.prewarmEngine, prompt]);
    useEffect(() => () => {
        generationRef.current += 1; abortRef.current?.abort(); prewarmAbortRef.current?.abort(); plannerRef.current?.cancelGeneration(); engineRef.current?.terminate();
    }, []);

    const emitEnrichment = useCallback((submission: Submission, value: LocalMoveEvaluation | null) => {
        if (submission.generation !== generationRef.current) return;
        const supported = value?.result.status === 'GRADED';
        const key = JSON.stringify([supported, value?.assessment, value?.patch]);
        if (submission.lastEvaluationKey === key) return;
        submission.lastEvaluationKey = key;
        const eventId = newClientId();
        onRefined.current?.(submission.prompt, {
            kind: 'ENRICH', clientAttemptId: submission.attemptId, momentRevisionId: submission.prompt.solutionRevisionId,
            stepIndex: submission.stepIndex, eventId, sequence: ++submission.eventSequence, supersedesEventId: submission.lastEventId,
            evaluatedAt: new Date().toISOString(), resolution: supported ? 'RESOLVED' : 'UNAVAILABLE',
            assessmentId: value?.assessment?.id ?? null, evaluation: value?.patch ?? null,
        });
        submission.lastEventId = eventId;
    }, []);

    const applyEvaluation = useCallback((value: LocalMoveEvaluation, submission: Submission, persist: boolean) => {
        if (submission.generation !== generationRef.current) return;
        if (value.result.status !== 'GRADED') {
            setAnswerHint(null);
            if (persist) emitEnrichment(submission, null);
            if (submission.followedRecommendation) {
                setRecommendationCreditRetained(true);
                rootGradeRef.current = 'GOOD';
                if (rootReviewRef.current) rootReviewRef.current = { ...rootReviewRef.current, comparison: null };
                setResponse({ status: 'GRADED', attemptId: submission.attemptId, quality: 'GOOD', tier: null, accepted: true,
                    originalRelation: 'UNKNOWN', refinement: 'UNRESOLVED', review: rootReviewRef.current ?? submission.prompt.review });
                setPhase('GRADED'); setPresentationSettled(true); setReviewFallback(false);
                if (!reviewPositionRef.current) dispatchPresentation({ type: 'GRADE_REVEAL', sequenceId: submission.sequenceId, moveUci: submission.moveUci, grade: 'GOOD' });
                return;
            }
            if (value.invalidatedKnownQuality) {
                if (submission.stepIndex === 0) {
                    rootGradeRef.current = null;
                    if (rootReviewRef.current) rootReviewRef.current = { ...rootReviewRef.current, comparison: null };
                }
                if (reviewPositionRef.current === 'ATTEMPT' && rootReviewRef.current?.submittedMoveUci)
                    dispatchPresentation({ type: 'REVIEW_ATTEMPT', sequenceId: submission.sequenceId, moveUci: rootReviewRef.current.submittedMoveUci, grade: rootGradeRef.current });
                else if (!reviewPositionRef.current) dispatchPresentation({ type: 'CHECKING', sequenceId: submission.sequenceId });
            }
            setReviewFallback(true);
            setResponse({ status: 'REVEALED', attemptId: submission.attemptId,
                review: rootReviewRef.current ?? { ...submission.prompt.review, submittedMoveUci: submission.moveUci, comparison: null } });
            setPhase('REVEALED'); setPresentationSettled(true);
            if (!reviewPositionRef.current) dispatchPresentation({ type: 'SETTLE', sequenceId: submission.sequenceId });
            return;
        }
        if (persist) emitEnrichment(submission, value);
        setAnswerHint(null);
        if (submission.followedRecommendation && value.result.quality !== 'GOOD') {
            setRecommendationCreditRetained(true);
            value = { ...value, followedRecommendation: true, result: { ...value.result, quality: 'GOOD', accepted: true, tier: null } };
        }
        if (value.result.status !== 'GRADED') return;
        const grade: Tier = value.result.tier ?? (value.result.quality === 'GOOD' ? 'GOOD' : 'SUBPAR');
        const previousQuality = submission.lastSupportedQuality;
        submission.lastSupportedQuality = value.result.quality;
        // The review contract is rooted in prompt.fen. Later USER evaluations
        // remain in their recorded step and must not replace root metrics/move.
        if (submission.stepIndex === 0) {
            rootReviewRef.current = { ...reviewWithLocalReference(submission.prompt.review, value, 0, submission.prompt.grading),
                submittedMoveUci: submission.moveUci, comparison: value.comparison };
            rootGradeRef.current = grade;
        }
        const graded: GradedPracticeResult = {
            attemptId: submission.attemptId, status: 'GRADED', quality: value.result.quality,
            tier: value.result.tier, originalRelation: value.result.originalRelation, accepted: value.result.accepted,
            review: rootReviewRef.current ?? submission.prompt.review,
        };
        setResponse({ ...graded, ...(previousQuality !== null ? { refinement: previousQuality !== graded.quality ? 'CORRECTED' as const : 'REFINED' as const } : {}) });
        setPhase('GRADED'); setPresentationSettled(true); setReviewFallback(false);
        // Refinement updates the verdict without changing the user's selected
        // review position or putting an after-move marker on the decision FEN.
        if (reviewPositionRef.current === 'ATTEMPT' && rootReviewRef.current?.submittedMoveUci)
            dispatchPresentation({ type: 'REVIEW_ATTEMPT', sequenceId: submission.sequenceId, moveUci: rootReviewRef.current.submittedMoveUci, grade: rootGradeRef.current });
        else if (!reviewPositionRef.current) {
            dispatchPresentation({ type: 'GRADE_REVEAL', sequenceId: submission.sequenceId, moveUci: submission.moveUci, grade });
            dispatchPresentation({ type: 'SETTLE', sequenceId: submission.sequenceId });
        }
        // Supported quality is immediately actionable; no grade animation timer delays Next.
        const continuation = value.result.accepted && !value.followedRecommendation ? localContinuationForMove({ manifest: submission.prompt.grading,
            node: submission.node, moveUci: submission.moveUci }) : null;
        if (continuation) {
            reviewPositionRef.current = null;
            nodeRef.current = continuation.nextUserNode;
            plannerRef.current = null;
            setSolveFen(continuation.fenAfterOpponentMove); setDisplayFen(continuation.fenAfterOpponentMove);
            setPhase('AWAITING_MOVE'); locked.current = false; startedAt.current = Date.now();
            dispatchPresentation({ type: 'OPPONENT_MOVE', sequenceId: submission.sequenceId, moveUci: continuation.opponentMoveUci });
            dispatchPresentation({ type: 'SETTLE', sequenceId: submission.sequenceId });
        }
    }, [emitEnrichment]);

    const runEvaluation = useCallback(async (submission: Submission, detail = false) => {
        if (submission.generation !== generationRef.current) return;
        const generation = submission.generation;
        const abort = new AbortController(); abortRef.current = abort;
        // One budget includes initialization, all passes and the one permitted runtime retry.
        const planner = detail ? new AnalysisWorkPlanner({ maxNodes: 200_000, maxWallMs: 2_000 }) : plannerRef.current ?? new AnalysisWorkPlanner({ maxNodes: 1_500_000, maxWallMs: 8_000 });
        if (!detail) plannerRef.current = planner;
        let emittedSupport = false;
        try {
            // Submit cancels optional work before this wait; do not compete for the engine queue.
            await prewarmWorkRef.current;
            if (generation !== generationRef.current || abort.signal.aborted) return;
            const value = await gradeUnknownLocalMove({ engine: getOrCreateEngine,
                retryEngine: () => { if (generation !== generationRef.current) throw new Error('Practice changed'); stopEngine(); return getOrCreateEngine(); },
                manifest: submission.prompt.grading, node: submission.node, moveUci: submission.moveUci,
                session: analysisRef.current, planner, signal: abort.signal, attemptId: submission.attemptId, refine: detail,
                onUpdate(update: LocalGradingUpdate) {
                    if (generation !== generationRef.current || abort.signal.aborted) return;
                    if (update.kind === 'LIVE') setLiveEvaluation({ score: update.score, depth: update.depth });
                    else { emittedSupport = update.kind === 'SUPPORTED'; applyEvaluation(update.evaluation, submission, true); }
                } });
            if (generation !== generationRef.current || abort.signal.aborted) return;
            if (!emittedSupport && (!detail || value.result.status === 'GRADED' || value.invalidatedKnownQuality)) applyEvaluation(value, submission, true);
            else if (!emittedSupport && detail) setResponse(previous => previous?.status === 'GRADED' ? { ...previous, refinement: 'UNRESOLVED' } : previous);
        } catch {
            if (generation !== generationRef.current || abort.signal.aborted) return;
            if (!emittedSupport && detail) setResponse(previous => previous?.status === 'GRADED' ? { ...previous, refinement: 'UNRESOLVED' } : previous);
            if (!emittedSupport && !detail) applyEvaluation({ result: { status: 'UNRESOLVED', reason: 'ENGINE_UNAVAILABLE' },
                source: 'CLIENT_EVALUATED', assessment: null, patch: null, refinementNeeded: false, scoreAfter: null, comparison: null }, submission, true);
        } finally {
            if (generation === generationRef.current && options.stopEngineOnTerminal && nodeRef.current?.contextId === submission.node.contextId) stopEngine();
        }
    }, [applyEvaluation, getOrCreateEngine, options.stopEngineOnTerminal, stopEngine]);

    const submitMove = useCallback(async ({ moveUci, fenAfterMove }: { moveUci: string; fenAfterMove: string }) => {
        const activePrompt = promptRef.current; const node = nodeRef.current;
        if (!activePrompt || !node || locked.current || (phase !== 'READY' && phase !== 'AWAITING_MOVE')) return;
        // Do not trust a board callback's claimed resulting position.
        try {
            const chess = new Chess(node.fen); chess.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion: moveUci[4] });
            if (chess.fen() !== fenAfterMove) return;
        } catch { return; }
        locked.current = true;
        prewarmAbortRef.current?.abort();
        attemptIdRef.current ??= newClientId();
        const submission: Submission = { node, stepIndex: userStepIndexRef.current++, moveUci, fenAfterMove, sequenceId: ++sequenceRef.current,
            generation: generationRef.current, attemptId: attemptIdRef.current, prompt: activePrompt, eventSequence: 0, lastEventId: null, lastEvaluationKey: null, lastSupportedQuality: null, followedRecommendation: false };
        submissionRef.current = submission;
        reviewPositionRef.current = null;
        const known = gradeKnownLocalMove({ manifest: activePrompt.grading, node, moveUci, session: analysisRef.current });
        submission.followedRecommendation = submission.stepIndex === 0 && node.contextId === activePrompt.grading.source.contextId
            && activePrompt.grading.contractVersion === 5 && moveUci === node.answerIndex?.preferredMoveUci
            && known?.result.status === 'GRADED' && known.result.quality === 'GOOD' && known.assessment?.qualitySupport === 'SUPPORTED';
        const lookup = node.answerIndex ? lookupAnswer(node.answerIndex, moveUci, activePrompt.grading.assessments, activePrompt.grading.coverageGroups) : null;
        // RECORD precedes any await/engine work: later quality enriches this exact event.
        onCompleted.current?.({ prompt: activePrompt, terminalReason: 'MOVE_SUBMITTED', request: {
            kind: 'RECORD', clientAttemptId: submission.attemptId, momentRevisionId: activePrompt.solutionRevisionId,
            contextId: node.contextId, stepIndex: submission.stepIndex, moveUci, playedAt: new Date().toISOString(),
            initialAssessmentId: known?.assessment?.id ?? null, initialCoverageGroupId: known && lookup?.kind === 'GROUP' ? lookup.coverageGroup.id : null, resolution: known ? 'RESOLVED' : 'PENDING',
            timeSpentMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt.current)),
        } });
        setSolveFen(fenAfterMove); setDisplayFen(fenAfterMove); setReviewFallback(false); setLiveEvaluation(null); setResponse(null);
        const estimate = !known && node.answerIndex ? observedAnswerRank(node.answerIndex, moveUci, activePrompt.grading) : null;
        setAnswerHint(estimate ? estimate.rank !== null ? `Ranked ${estimate.rank} in the current engine lines; checking the move.`
            : `Not among the ${estimate.lineCount} current engine ${estimate.lineCount === 1 ? 'line' : 'lines'}; checking the move.` : null);
        dispatchPresentation({ type: 'RESET', sequenceId: submission.sequenceId });
        dispatchPresentation({ type: 'USER_MOVE', sequenceId: submission.sequenceId, moveUci });
        if (known) {
            applyEvaluation(known, submission, false);
            if ((!known.assessment || known.assessment.tierSupport !== 'SUPPORTED') && !localContinuationForMove({ manifest: activePrompt.grading, node, moveUci })) {
                setResponse(previous => previous?.status === 'GRADED' ? { ...previous, refinement: 'PENDING' } : previous);
                await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
                await runEvaluation(submission, true);
            }
            return;
        }
        setPhase('SUBMITTING'); setResponse(null); setPresentationSettled(false);
        dispatchPresentation({ type: 'CHECKING', sequenceId: submission.sequenceId });
        // Let the pending board frame paint before synchronous evidence replay.
        // The same budget includes this scheduling delay and all later work.
        plannerRef.current ??= new AnalysisWorkPlanner({ maxNodes: 1_500_000, maxWallMs: 8_000 });
        await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
        await runEvaluation(submission);
    }, [applyEvaluation, phase, runEvaluation]);

    const reveal = useCallback(() => {
        const activePrompt = promptRef.current;
        if (!activePrompt || locked.current || (phase !== 'READY' && phase !== 'AWAITING_MOVE')) return;
        locked.current = true; attemptIdRef.current ??= newClientId();
        prewarmAbortRef.current?.abort(); setAnswerHint(null);
        setResponse({ status: 'REVEALED', attemptId: attemptIdRef.current, review: rootReviewRef.current ?? activePrompt.review });
        setDisplayFen(activePrompt.fen); setPhase('REVEALED'); setReviewFallback(false); setPresentationSettled(true);
        dispatchPresentation({ type: 'RESET', sequenceId: ++sequenceRef.current });
        onCompleted.current?.({ prompt: activePrompt, terminalReason: 'REVEALED', request: {
            kind: 'REVEAL', clientAttemptId: attemptIdRef.current, momentRevisionId: activePrompt.solutionRevisionId, revealedAt: new Date().toISOString(),
        } });
        if (options.stopEngineOnTerminal) stopEngine();
    }, [options.stopEngineOnTerminal, phase, stopEngine]);
    const grade: Tier | null = response?.status === 'GRADED' ? response.tier ?? (response.quality === 'GOOD' ? 'GOOD' : 'SUBPAR') : null;
    const review = phase === 'GRADED' || phase === 'REVEALED' ? reviewFromTrainingResponse(response) : null;
    const showReviewPosition = useCallback((position: 'DECISION' | 'ATTEMPT') => {
        const activePrompt = promptRef.current;
        if (!activePrompt || !review) return;
        if (position === 'DECISION' || !review.submittedMoveUci) {
            reviewPositionRef.current = 'DECISION';
            setDisplayFen(activePrompt.fen); dispatchPresentation({ type: 'REVIEW_DECISION', sequenceId: sequenceRef.current }); return;
        }
        try {
            const chess = new Chess(activePrompt.fen); const move = review.submittedMoveUci;
            chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); setDisplayFen(chess.fen());
            reviewPositionRef.current = 'ATTEMPT';
            dispatchPresentation({ type: 'REVIEW_ATTEMPT', sequenceId: sequenceRef.current, moveUci: move, grade: rootGradeRef.current });
        } catch { setDisplayFen(activePrompt.fen); }
    }, [review]);
    const story = useMemo(() => prompt && review ? buildPostMoveStory({ prompt, review, grade: rootGradeRef.current }) : null, [prompt, review]);
    const attemptTerminal = phase === 'GRADED' || phase === 'REVEALED';
    const beginPresentation = useCallback(() => setPresentationSettled(false), []);
    const settlePresentation = useCallback(() => setPresentationSettled(true), []);
    const retryGrading = useCallback(async () => {
        // Exhausted automatic budgets remain exhausted. Review is always available.
        if (submissionRef.current && phase === 'UNRESOLVED') await runEvaluation(submissionRef.current);
    }, [phase, runEvaluation]);
    return { prompt, positionFen: solveFen, solveFen, displayFen, phase, grade,
        quality: response?.status === 'GRADED' ? response.quality : 'UNKNOWN',
        originalRelation: response?.status === 'GRADED' ? response.originalRelation : 'UNKNOWN', liveEvaluation, answerHint, recommendationCreditRetained,
        refinement: response?.status === 'GRADED' ? response.refinement : undefined,
        unresolved: response?.status === 'UNRESOLVED' ? { reason: response.reason } : null,
        review, reviewFallback, story, attemptTerminal, presentationSettled, presentation,
        terminal: attemptTerminal && presentationSettled, engineClient,
        canMove: phase === 'READY' || phase === 'AWAITING_MOVE', canReveal: phase === 'READY' || phase === 'AWAITING_MOVE',
        activatePrompt, clearPrompt, getOrCreateEngine, stopEngine, submitMove, retryGrading, reveal, showReviewPosition,
        beginPresentation, settlePresentation };
}
