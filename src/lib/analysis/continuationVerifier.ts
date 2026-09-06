import { Chess } from 'chess.js';
import type {
    AnalysisLimit,
    EngineIdentity,
    EngineWdl,
    MultiPvLine,
    MultiPvResult,
    Score,
    StockfishEngine,
    SearchEvidence,
} from './stockfishClient';
import {
    pieceCountFromFen,
    type TablebaseEvidence,
    type TablebaseProvider,
    type TablebaseWdl,
} from './tablebase';
import { ruleTerminalEvaluation, claimableDraw } from './ruleEvaluation';
import { winningChance } from './evaluation';
import { normalizeGradingPolicy } from '@/lib/training/config';
import type {
    AcceptanceFrontier,
    AnswerCoverage,
    GradingPolicyV3,
    SolutionShape,
    VerificationStatus,
    ContinuationReadiness,
} from '@/lib/training/contracts';
import {
    acceptanceFrontierFromMultiPv,
    confirmAcceptanceFrontier,
} from '@/lib/training/acceptanceFrontier';
import {
    assessmentPositionKey,
    appendAssessmentHistory,
} from '@/lib/training/assessmentIdentity';

export const CONTINUATION_STOP_REASONS = [
    'CHECKMATE',
    'STALEMATE',
    'INSUFFICIENT_MATERIAL',
    'SEVENTY_FIVE_MOVE_RULE',
    'FIVEFOLD_REPETITION',
    'FIFTY_MOVE',
    'THREEFOLD_REPETITION',
    'MAX_PLIES',
    'MAX_POSITIONS',
    'NO_STABLE_LINE',
] as const;
export type ContinuationStopReason = (typeof CONTINUATION_STOP_REASONS)[number];
export type VerifiedMoveEvaluation =
    | {
          source: 'ENGINE';
          score: Score | null;
          wdl?: EngineWdl;
          depth?: number;
          nodes?: number;
          searchEvidence?: SearchEvidence;
      }
    | {
          source: 'TABLEBASE';
          wdl: TablebaseWdl;
          dtz?: number;
          preciseDtz?: number;
          categoryAfterMove: string;
      }
    | {
          source: 'RULE';
          outcome: 'DRAW';
          reason: 'THREEFOLD_REPETITION' | 'FIFTY_MOVE_RULE';
      };
export type VerifiedSolutionBranch = {
    moveUci: string;
    best: boolean;
    evaluation: VerifiedMoveEvaluation;
    child: VerifiedSolutionNode;
};
export type VerifiedSolutionNode = {
    fen: string;
    contextId: string;
    positionHistory: string[];
    ply: number;
    role: 'USER' | 'OPPONENT' | 'TERMINAL';
    evidenceSource: 'ENGINE' | 'TABLEBASE' | 'RULE' | 'NONE';
    acceptedMovesUci: string[];
    selectedMoveUci?: string;
    alternativesComplete: boolean;
    acceptanceFrontier?: AcceptanceFrontier;
    answerCoverage?: AnswerCoverage;
    tablebase?: TablebaseEvidence;
    branches: VerifiedSolutionBranch[];
    stopReason?: ContinuationStopReason;
    moveEvaluations?: Array<{
        moveUci: string;
        evaluation: VerifiedMoveEvaluation;
        tierStable: boolean;
    }>;
    referenceId?: string;
    explanationAvailable?: boolean;
    gradedContinuationReady?: boolean;
};
export type ContinuationVerifierOptions = {
    maxPlies?: number;
    maxPositions?: number;
    multiPv?: number;
    maxMultiPv?: number;
    maxUserBranches?: number;
    maxAcceptedWinningChanceLoss?: number;
    fallbackMaxAcceptedCpLoss?: number;
    gradingPolicy?: GradingPolicyV3;
    nodesPerPosition?: number | null;
    maxDepth?: number | null;
    movetimeMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    previousFens?: string[];
    seed?: MultiPvResult;
};
export type ContinuationVerificationResult = {
    status: VerificationStatus;
    solutionShape: SolutionShape;
    root: VerifiedSolutionNode;
    acceptedMovesUci: string[];
    bestLineUci: string[];
    stopReasons: ContinuationStopReason[];
    engineIdentity?: EngineIdentity;
    answerCoverage: AnswerCoverage;
    continuation: ContinuationReadiness;
    bounds: {
        maxPlies: number;
        maxPositions: number;
        multiPv: number;
        maxMultiPv: number;
        largestMultiPvRequested: number;
        maxUserBranches: number;
        nodesPerPosition: number | null;
        maxDepth: number | null;
        positionsVisited: number;
    };
    diagnostics: string[];
};

const uci = (move: { from: string; to: string; promotion?: string }) =>
    `${move.from}${move.to}${move.promotion ?? ''}`;
function apply(fen: string, move: string): string | null {
    try {
        const chess = new Chess(fen);
        chess.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.slice(4) || undefined,
        });
        return chess.fen();
    } catch {
        return null;
    }
}
function evaluation(
    line: MultiPvLine,
    result: MultiPvResult,
): VerifiedMoveEvaluation {
    return {
        source: 'ENGINE',
        score: line.score,
        wdl: line.wdl,
        depth: line.depth,
        nodes: line.nodes,
        searchEvidence: result.searchEvidence,
    };
}
function stop(
    fen: string,
    history: string[],
    ply: number,
    reason: ContinuationStopReason,
    evidenceSource: VerifiedSolutionNode['evidenceSource'] = 'NONE',
): VerifiedSolutionNode {
    return {
        fen,
        contextId: assessmentPositionKey(fen, history),
        positionHistory: history,
        ply,
        role: 'TERMINAL',
        evidenceSource,
        acceptedMovesUci: [],
        alternativesComplete: true,
        branches: [],
        stopReason: reason,
        explanationAvailable: false,
        gradedContinuationReady: false,
    };
}
function legalLines(fen: string, result: MultiPvResult): MultiPvLine[] {
    const first = result.lines.find((line) => line.multipv === 1);
    if (!first?.score || !first.pvUci[0] || !apply(fen, first.pvUci[0]))
        throw new Error('Invalid best engine evidence');
    const seen = new Set<string>();
    return result.lines
        .slice()
        .sort((a, b) => a.multipv - b.multipv)
        .filter((line) => {
            const root = line.pvUci[0]?.trim().toLowerCase();
            if (!root || !line.score || seen.has(root) || !apply(fen, root))
                return false;
            seen.add(root);
            return true;
        })
        .map((line, index) => ({ ...line, multipv: index + 1 }));
}

/** A reliable root plus bounded explanations. Optional enrichment never invalidates it. */
export async function verifyConditionalContinuation(args: {
    fen: string;
    engine: StockfishEngine;
    tablebase?: TablebaseProvider;
    options?: ContinuationVerifierOptions;
}): Promise<ContinuationVerificationResult> {
    const options = args.options ?? {};
    const policy =
        options.gradingPolicy ??
        normalizeGradingPolicy({
            success: {
                maxCpLoss: options.fallbackMaxAcceptedCpLoss ?? 100,
                maxWinChanceLoss: options.maxAcceptedWinningChanceLoss ?? 0.1,
            },
        });
    const nodes =
        options.nodesPerPosition === null
            ? null
            : (options.nodesPerPosition ?? 100000);
    const multiPv = Math.max(1, Math.min(16, options.multiPv ?? 5));
    const maxPlies = Math.max(1, Math.min(32, options.maxPlies ?? 2));
    const maxPositions = Math.max(1, Math.min(128, options.maxPositions ?? 32));
    const maxBranches = Math.max(
        1,
        Math.min(16, options.maxUserBranches ?? 16),
    );
    const history = options.previousFens ?? [];
    const diagnostics: string[] = [];
    let positionsVisited = 0;
    let largestMultiPvRequested = 0;
    const limit = (multiplier = 1): AnalysisLimit => ({
        ...(nodes != null
            ? { nodes: nodes * multiplier }
            : options.maxDepth
              ? { depth: options.maxDepth }
              : { movetimeMs: (options.movetimeMs ?? 250) * multiplier }),
        timeoutMs: options.timeoutMs ?? 30000,
        signal: options.signal,
        reuse: 'FRESH_REQUIRED',
    });
    const run = async (
        fen: string,
        previousFens: string[],
        count: number,
        multiplier = 1,
    ) => {
        positionsVisited++;
        largestMultiPvRequested = Math.max(largestMultiPvRequested, count);
        const result = await args.engine.analyzeMultiPv({
            fen,
            multiPv: count,
            previousFens,
            ...limit(multiplier),
            purpose: 'ANSWER_COVERAGE',
        });
        if (options.signal?.aborted) throw new Error('Analysis aborted');
        return result;
    };
    const emptyCoverage = (
        fen: string,
        previousFens: string[],
        referenceId: string,
    ): AnswerCoverage => ({
        version: 1,
        contextId: assessmentPositionKey(fen, previousFens),
        status: 'PARTIAL',
        legalMovesUci: new Chess(fen).moves({ verbose: true }).map(uci).sort(),
        assessedMovesUci: [],
        coveredMovesUci: [],
        referenceId,
        policyVersion: policy.version,
        reason: 'BOUNDARY_NOT_REACHED',
    });
    let root: VerifiedSolutionNode;
    let coverage: AnswerCoverage;
    let frontier: AcceptanceFrontier;
    let rootResults: Array<{
        moveUci: string;
        evaluation: VerifiedMoveEvaluation;
        tierStable: boolean;
    }> = [];
    let rootStatus: VerificationStatus = 'VERIFIED';
    const referenceId =
        options.seed?.searchEvidence?.id ??
        `root:${assessmentPositionKey(args.fen, history)}`;
    try {
        const terminal = ruleTerminalEvaluation(args.fen, history);
        if (terminal) {
            root = stop(
                args.fen,
                history,
                0,
                terminal.terminal!.kind as ContinuationStopReason,
                'RULE',
            );
            coverage = emptyCoverage(args.fen, history, referenceId);
            return {
                status: 'INVALID',
                solutionShape: 'OPEN',
                root,
                acceptedMovesUci: [],
                bestLineUci: [],
                answerCoverage: coverage,
                continuation: {
                    status: 'NONE',
                    explanationAvailable: false,
                    gradedContinuationReady: false,
                },
                stopReasons: [root.stopReason!],
                bounds: {
                    maxPlies,
                    maxPositions,
                    multiPv,
                    maxMultiPv: options.maxMultiPv ?? 16,
                    largestMultiPvRequested,
                    maxUserBranches: maxBranches,
                    nodesPerPosition: nodes,
                    maxDepth: options.maxDepth ?? null,
                    positionsVisited,
                },
                diagnostics: ['Root has no decision'],
            };
        }
        coverage = emptyCoverage(args.fen, history, referenceId);
        let exact: TablebaseEvidence | null = null;
        if (
            !options.seed &&
            args.tablebase &&
            (pieceCountFromFen(args.fen) ?? 99) <= 7
        )
            try {
                exact = await args.tablebase.probe(args.fen, {
                    signal: options.signal,
                });
            } catch (error) {
                if (options.signal?.aborted) throw error;
                diagnostics.push('Tablebase unavailable; used engine evidence');
            }
        if (
            exact &&
            exact.wdl !== 'UNKNOWN' &&
            exact.moves.some((move) => move.wdl !== 'UNKNOWN')
        ) {
            const rank = (value: TablebaseWdl) =>
                value === 'WIN'
                    ? 3
                    : value === 'DRAW'
                      ? 2
                      : value === 'LOSS'
                        ? 1
                        : 0;
            const legal = new Set(coverage.legalMovesUci);
            const known = exact.moves.filter(
                (move) => legal.has(move.uci) && move.wdl !== 'UNKNOWN',
            );
            const best = Math.max(...known.map((move) => rank(move.wdl)));
            const accepted = known
                .filter(
                    (move) =>
                        rank(move.wdl) === best &&
                        rank(move.wdl) >= rank(exact!.wdl),
                )
                .slice(0, maxBranches);
            rootResults = known.map((move) => ({
                moveUci: move.uci,
                evaluation: {
                    source: 'TABLEBASE',
                    wdl: move.wdl,
                    categoryAfterMove: move.categoryAfterMove,
                    dtz: move.dtz,
                },
                tierStable: true,
            }));
            frontier = {
                version: 1,
                status: accepted.length ? 'STABLE' : 'OPEN',
                targetCutoffCp: policy.success.maxCpLoss,
                effectiveCutoffCp: null,
                boundaryGapCp: null,
                moves: accepted.map((move) => ({
                    moveUci: move.uci,
                    tier: 'BEST',
                })),
                firstRejectedMoveUci:
                    known.find((move) => rank(move.wdl) < best)?.uci ?? null,
            };
            coverage.assessedMovesUci = known.map((move) => move.uci).sort();
            coverage.referenceId = `tablebase:${referenceId}`;
        } else {
            const first =
                options.seed?.fen === args.fen && options.seed.lines.length
                    ? options.seed
                    : await run(args.fen, history, multiPv);
            const firstLines = legalLines(args.fen, first);
            frontier = acceptanceFrontierFromMultiPv({
                lines: firstLines,
                requestedMultiPv: multiPv,
                alternativesComplete: first.alternativesComplete,
                policy,
            });
            let selected = first;
            let stableTiers = new Map(
                frontier.moves.map((move, index) => [
                    move.moveUci,
                    !options.seed || index === 0,
                ]),
            );
            // A seed is the already-confirmed decision reference. A standalone
            // verifier obtains its own second observation, conserving only the core.
            if (!options.seed && positionsVisited < maxPositions) {
                const second = await run(args.fen, history, multiPv, 2);
                const next = acceptanceFrontierFromMultiPv({
                    lines: legalLines(args.fen, second),
                    requestedMultiPv: multiPv,
                    alternativesComplete: second.alternativesComplete,
                    policy,
                });
                stableTiers = new Map(
                    next.moves.map((move) => [
                        move.moveUci,
                        frontier.moves.find(
                            (previous) => previous.moveUci === move.moveUci,
                        )?.tier === move.tier,
                    ]),
                );
                frontier = confirmAcceptanceFrontier(frontier, next);
                selected = second;
            }
            const selectedLines = legalLines(args.fen, selected);
            if (
                !frontier.moves.some(
                    (move) => move.moveUci === selectedLines[0]?.pvUci[0],
                )
            ) {
                // A newly discovered better reference needs its own confirmation.
                // Do not silently rebase a further graded decision to a weaker move.
                rootStatus = 'UNSTABLE';
                diagnostics.push(
                    'Best reference changed outside independently supported answers',
                );
            }
            rootResults = selectedLines.map((line) => ({
                moveUci: line.pvUci[0]!,
                evaluation: evaluation(line, selected),
                tierStable: stableTiers.get(line.pvUci[0]!) ?? false,
            }));
            coverage.assessedMovesUci = rootResults
                .map((move) => move.moveUci)
                .sort();
            coverage.referenceId = selected.searchEvidence?.id ?? referenceId;
            if (first.lines.length !== firstLines.length)
                diagnostics.push(
                    'Malformed/duplicate lines were excluded from answer evidence',
                );
        }
        const claimMoves = coverage.legalMovesUci
            .map((moveUci) => ({ moveUci, nextFen: apply(args.fen, moveUci)! }))
            .map((move) => ({
                ...move,
                reason: claimableDraw(move.nextFen, [...history, args.fen]),
            }))
            .filter((move) => move.reason != null);
        if (!options.seed && claimMoves.length) {
            const bestItem = rootResults.find(
                (item) => item.moveUci === frontier.moves[0]?.moveUci,
            );
            const bestChance =
                bestItem?.evaluation.source === 'ENGINE'
                    ? winningChance(
                          bestItem.evaluation.score,
                          bestItem.evaluation.wdl,
                      )
                    : bestItem?.evaluation.source === 'TABLEBASE'
                      ? bestItem.evaluation.wdl === 'WIN'
                          ? 1
                          : bestItem.evaluation.wdl === 'LOSS'
                            ? 0
                            : 0.5
                      : 0.5;
            const drawBest =
                (bestChance != null && bestChance < 0.5) ||
                claimMoves.some(
                    (move) => move.moveUci === frontier.moves[0]?.moveUci,
                );
            const drawAccepted =
                drawBest ||
                (bestChance != null &&
                    bestChance - 0.5 <= policy.success.maxWinChanceLoss &&
                    (bestItem?.evaluation.source !== 'ENGINE' ||
                        bestItem.evaluation.score?.type !== 'cp' ||
                        bestItem.evaluation.score.value <=
                            policy.success.maxCpLoss));
            for (const move of claimMoves) {
                rootResults = rootResults.filter(
                    (item) => item.moveUci !== move.moveUci,
                );
                rootResults.push({
                    moveUci: move.moveUci,
                    evaluation: {
                        source: 'RULE',
                        outcome: 'DRAW',
                        reason: move.reason!,
                    },
                    tierStable: true,
                });
            }
            if (drawBest) {
                frontier = {
                    ...frontier,
                    status: 'STABLE',
                    moves: claimMoves.map((move) => ({
                        moveUci: move.moveUci,
                        tier: 'BEST',
                    })),
                };
            } else if (drawAccepted) {
                frontier = {
                    ...frontier,
                    moves: [
                        ...frontier.moves.filter(
                            (item) =>
                                !claimMoves.some(
                                    (move) => move.moveUci === item.moveUci,
                                ),
                        ),
                        ...claimMoves.map((move) => ({
                            moveUci: move.moveUci,
                            tier: 'GOOD' as const,
                        })),
                    ],
                };
            }
            coverage.assessedMovesUci = rootResults
                .map((item) => item.moveUci)
                .sort();
        }
        coverage.status = coverage.legalMovesUci.every((move) =>
            coverage.assessedMovesUci.includes(move),
        )
            ? 'ALL_LEGAL_ASSESSED'
            : 'PARTIAL';
        coverage.reason =
            coverage.status === 'ALL_LEGAL_ASSESSED'
                ? 'ALL_LEGAL_MOVES_EVALUATED'
                : 'ENRICHMENT_BUDGET_EXHAUSTED';
        const accepted = frontier.moves.slice(0, maxBranches);
        frontier = { ...frontier, moves: accepted };
        if (!accepted.length || frontier.status === 'UNSTABLE')
            rootStatus = 'UNSTABLE';
        const first = accepted[0]?.moveUci;
        root = {
            fen: args.fen,
            contextId: coverage.contextId,
            positionHistory: history,
            ply: 0,
            role: 'USER',
            evidenceSource:
                rootResults.find((item) => item.moveUci === first)?.evaluation
                    .source ?? 'ENGINE',
            acceptedMovesUci: accepted.map((move) => move.moveUci),
            selectedMoveUci: first,
            alternativesComplete: coverage.status === 'ALL_LEGAL_ASSESSED',
            acceptanceFrontier: frontier,
            answerCoverage: coverage,
            branches: [],
            moveEvaluations: rootResults,
            referenceId: coverage.referenceId,
            explanationAvailable: false,
            gradedContinuationReady: false,
        };
        for (const [index, acceptedMove] of accepted.entries()) {
            const item = rootResults.find(
                (move) => move.moveUci === acceptedMove.moveUci,
            );
            const nextFen = apply(args.fen, acceptedMove.moveUci);
            if (!item || !nextFen) continue;
            const nextHistory = appendAssessmentHistory(history, args.fen);
            let child = stop(nextFen, nextHistory, 1, 'MAX_PLIES');
            const terminal = ruleTerminalEvaluation(nextFen, nextHistory);
            const claim = claimableDraw(nextFen, nextHistory);
            if (terminal)
                child = stop(
                    nextFen,
                    nextHistory,
                    1,
                    terminal.terminal!.kind as ContinuationStopReason,
                    'RULE',
                );
            else if (claim)
                child = stop(
                    nextFen,
                    nextHistory,
                    1,
                    claim === 'FIFTY_MOVE_RULE'
                        ? 'FIFTY_MOVE'
                        : 'THREEFOLD_REPETITION',
                    'RULE',
                );
            else if (
                index === 0 &&
                maxPlies > 1 &&
                positionsVisited < maxPositions
            ) {
                // Only the preferred branch is enriched eagerly. A different
                // answer remains its own branch; never redirect it to this PV.
                try {
                    const reply = await run(nextFen, nextHistory, 1);
                    const line = legalLines(nextFen, reply)[0];
                    const replyMove = line?.pvUci[0];
                    const replyFen = replyMove
                        ? apply(nextFen, replyMove)
                        : null;
                    if (line && replyMove && replyFen) {
                        const replyHistory = appendAssessmentHistory(
                            nextHistory,
                            nextFen,
                        );
                        const end = ruleTerminalEvaluation(
                            replyFen,
                            replyHistory,
                        );
                        const replyClaim = claimableDraw(
                            replyFen,
                            replyHistory,
                        );
                        child = {
                            fen: nextFen,
                            contextId: assessmentPositionKey(
                                nextFen,
                                nextHistory,
                            ),
                            positionHistory: nextHistory,
                            ply: 1,
                            role: 'OPPONENT',
                            evidenceSource: 'ENGINE',
                            acceptedMovesUci: [],
                            selectedMoveUci: replyMove,
                            alternativesComplete: false,
                            branches: [
                                {
                                    moveUci: replyMove,
                                    best: true,
                                    evaluation: evaluation(line, reply),
                                    child: stop(
                                        replyFen,
                                        replyHistory,
                                        2,
                                        end
                                            ? (end.terminal!
                                                  .kind as ContinuationStopReason)
                                            : replyClaim === 'FIFTY_MOVE_RULE'
                                              ? 'FIFTY_MOVE'
                                              : replyClaim ===
                                                  'THREEFOLD_REPETITION'
                                                ? 'THREEFOLD_REPETITION'
                                                : 'MAX_PLIES',
                                        end || replyClaim ? 'RULE' : 'NONE',
                                    ),
                                },
                            ],
                            explanationAvailable: true,
                            gradedContinuationReady: false,
                        };
                        root.explanationAvailable = true;
                    }
                } catch (error) {
                    if (options.signal?.aborted) throw error;
                    diagnostics.push(
                        'Optional preferred continuation unavailable; root retained',
                    );
                    child = stop(nextFen, nextHistory, 1, 'NO_STABLE_LINE');
                }
            }
            if (
                index === 0 &&
                maxPlies > 2 &&
                child.role === 'OPPONENT' &&
                child.branches[0] &&
                positionsVisited < maxPositions
            ) {
                const leaf = child.branches[0].child;
                if (leaf.stopReason === 'MAX_PLIES') {
                    const nested = await verifyConditionalContinuation({
                        fen: leaf.fen,
                        engine: args.engine,
                        tablebase: args.tablebase,
                        options: {
                            ...options,
                            seed: undefined,
                            previousFens: leaf.positionHistory,
                            maxPlies: maxPlies - 2,
                            maxPositions: maxPositions - positionsVisited,
                        },
                    });
                    positionsVisited += nested.bounds.positionsVisited;
                    if (
                        nested.status === 'VERIFIED' &&
                        nested.acceptedMovesUci.length
                    ) {
                        const offset = (node: VerifiedSolutionNode) => {
                            node.ply += 2;
                            for (const branch of node.branches)
                                offset(branch.child);
                        };
                        offset(nested.root);
                        child.branches[0].child = nested.root;
                        root.gradedContinuationReady = true;
                    } else
                        diagnostics.push(
                            'Additional user decision unresolved; explanation stops before grading it',
                        );
                }
            }
            root.branches.push({
                moveUci: item.moveUci,
                best: index === 0,
                evaluation: item.evaluation,
                child,
            });
        }
    } catch (error) {
        if (options.signal?.aborted) throw error;
        diagnostics.push(
            error instanceof Error ? error.message : 'Invalid root evidence',
        );
        rootStatus = 'UNSTABLE';
        coverage = emptyCoverage(args.fen, history, referenceId);
        root = stop(args.fen, history, 0, 'NO_STABLE_LINE');
    }
    const bestLineUci: string[] = [];
    const stopReasons = new Set<ContinuationStopReason>();
    const collect = (node: VerifiedSolutionNode) => {
        if (node.stopReason) stopReasons.add(node.stopReason);
        for (const branch of node.branches) collect(branch.child);
    };
    collect(root);
    let node = root;
    while (node.branches.length) {
        const branch =
            node.branches.find((item) => item.best) ?? node.branches[0]!;
        bestLineUci.push(branch.moveUci);
        node = branch.child;
    }
    const continuation: ContinuationReadiness = {
        status: root.gradedContinuationReady
            ? 'GRADED_BRANCHES_READY'
            : bestLineUci.length > 1
              ? 'EXPLANATION_ONLY'
              : 'NONE',
        explanationAvailable: bestLineUci.length > 1,
        gradedContinuationReady: root.gradedContinuationReady === true,
    };
    // Claimable draws are not automatically terminal: their availability is
    // recorded without pretending the source game stopped by claiming them.
    const claim = claimableDraw(args.fen, history);
    if (claim) diagnostics.push(`Draw claim available: ${claim}`);
    let engineIdentity: EngineIdentity | undefined;
    try {
        engineIdentity = await args.engine.getIdentity?.();
    } catch {
        /* Evidence absence remains explicit. */
    }
    if (options.signal?.aborted) throw new Error('Analysis aborted');
    return {
        status: rootStatus,
        solutionShape:
            root.acceptedMovesUci.length > 1
                ? 'MULTIPLE'
                : root.acceptedMovesUci.length === 1
                  ? 'UNIQUE'
                  : 'OPEN',
        root,
        acceptedMovesUci: root.acceptedMovesUci,
        bestLineUci,
        answerCoverage: coverage,
        continuation,
        stopReasons: [...stopReasons],
        engineIdentity,
        bounds: {
            maxPlies,
            maxPositions,
            multiPv,
            maxMultiPv: options.maxMultiPv ?? 16,
            largestMultiPvRequested,
            maxUserBranches: maxBranches,
            nodesPerPosition: nodes,
            maxDepth: options.maxDepth ?? null,
            positionsVisited,
        },
        diagnostics,
    };
}
