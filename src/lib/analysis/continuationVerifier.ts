import { Chess } from 'chess.js';
import {
    evaluationLoss,
    isWithinEvaluationLoss,
    qualifiesEvaluationLoss,
    scoreToOrderingCp,
    winningChance,
} from '@/lib/analysis/evaluation';
import type {
    AnalysisLimit,
    EngineIdentity,
    EngineWdl,
    MultiPvLine,
    MultiPvResult,
    Score,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import {
    pieceCountFromFen,
    type TablebaseEvidence,
    type TablebaseMoveEvidence,
    type TablebaseProvider,
    type TablebaseWdl,
} from '@/lib/analysis/tablebase';
import type {
    AcceptanceFrontier,
    GradingPolicyV3,
    SolutionShape,
    VerificationStatus,
} from '@/lib/training/contracts';
import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    acceptanceFrontierFromMultiPv,
    confirmAcceptanceFrontier,
} from '@/lib/training/acceptanceFrontier';

export const CONTINUATION_STOP_REASONS = [
    'CHECKMATE',
    'STALEMATE',
    'INSUFFICIENT_MATERIAL',
    'FIFTY_MOVE',
    'THREEFOLD_REPETITION',
    'MAX_PLIES',
    'MAX_POSITIONS',
    'NO_STABLE_LINE',
] as const;

export type ContinuationStopReason =
    (typeof CONTINUATION_STOP_REASONS)[number];

export type VerifiedMoveEvaluation =
    | {
          source: 'ENGINE';
          score: Score | null;
          wdl?: EngineWdl;
          depth?: number;
          nodes?: number;
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
          reason: 'THREEFOLD_REPETITION';
      };

export type VerifiedSolutionBranch = {
    moveUci: string;
    best: boolean;
    evaluation: VerifiedMoveEvaluation;
    child: VerifiedSolutionNode;
};

export type VerifiedSolutionNode = {
    fen: string;
    ply: number;
    role: 'USER' | 'OPPONENT' | 'TERMINAL';
    evidenceSource: 'ENGINE' | 'TABLEBASE' | 'RULE' | 'NONE';
    acceptedMovesUci: string[];
    selectedMoveUci?: string;
    alternativesComplete: boolean;
    acceptanceFrontier?: AcceptanceFrontier;
    tablebase?: TablebaseEvidence;
    branches: VerifiedSolutionBranch[];
    stopReason?: ContinuationStopReason;
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
    /**
     * Positions before the root, in source-game order. They let repetition
     * adjudication retain the game context instead of considering only the PV.
     */
    previousFens?: string[];
};

export type ContinuationVerificationResult = {
    status: VerificationStatus;
    solutionShape: SolutionShape;
    root: VerifiedSolutionNode;
    acceptedMovesUci: string[];
    bestLineUci: string[];
    stopReasons: ContinuationStopReason[];
    engineIdentity?: EngineIdentity;
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

type ResolvedVerifierOptions = {
    maxPlies: number;
    maxPositions: number;
    multiPv: number;
    maxMultiPv: number;
    maxUserBranches: number;
    maxAcceptedWinningChanceLoss: number;
    fallbackMaxAcceptedCpLoss: number;
    gradingPolicy: GradingPolicyV3;
    nodesPerPosition: number | null;
    maxDepth: number | null;
    movetimeMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    previousFens: string[];
};

type BuildState = {
    positionsVisited: number;
    largestMultiPvRequested: number;
    status: VerificationStatus;
    diagnostics: string[];
};

function resolvedOptions(
    options: ContinuationVerifierOptions
): ResolvedVerifierOptions {
    const multiPv = Math.max(
        2,
        Math.min(16, Math.trunc(options.multiPv ?? 5))
    );
    const gradingPolicy =
        options.gradingPolicy ??
        normalizeGradingPolicy({
            success: {
                maxCpLoss: options.fallbackMaxAcceptedCpLoss ?? 100,
                maxWinChanceLoss:
                    options.maxAcceptedWinningChanceLoss ?? 0.1,
            },
        });
    return {
        maxPlies: Math.max(1, Math.min(32, options.maxPlies ?? 8)),
        maxPositions: Math.max(
            1,
            Math.min(128, options.maxPositions ?? 32)
        ),
        multiPv,
        maxMultiPv: Math.max(
            multiPv,
            Math.min(
                16,
                Math.trunc(options.maxMultiPv ?? multiPv)
            )
        ),
        maxUserBranches: Math.max(
            1,
            Math.min(16, options.maxUserBranches ?? 16)
        ),
        maxAcceptedWinningChanceLoss: Math.max(
            0,
            Math.min(1, options.maxAcceptedWinningChanceLoss ?? 0.05)
        ),
        fallbackMaxAcceptedCpLoss: Math.max(
            0,
            options.fallbackMaxAcceptedCpLoss ??
                gradingPolicy.success.maxCpLoss
        ),
        gradingPolicy,
        nodesPerPosition:
            options.nodesPerPosition === null
                ? null
                : Math.max(1, options.nodesPerPosition ?? 100_000),
        maxDepth:
            options.maxDepth == null
                ? null
                : Math.max(1, options.maxDepth),
        movetimeMs: Math.max(1, options.movetimeMs ?? 250),
        timeoutMs: Math.max(1_000, options.timeoutMs ?? 30_000),
        signal: options.signal,
        previousFens: options.previousFens ?? [],
    };
}

function analysisLimit(options: ResolvedVerifierOptions): AnalysisLimit {
    return {
        ...(options.nodesPerPosition != null
            ? { nodes: options.nodesPerPosition }
            : options.maxDepth != null
              ? { depth: options.maxDepth }
              : { movetimeMs: options.movetimeMs }),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
    };
}

function confirmationAnalysisLimit(
    options: ResolvedVerifierOptions
): AnalysisLimit {
    return {
        ...(options.nodesPerPosition != null
            ? { nodes: options.nodesPerPosition * 2 }
            : options.maxDepth != null
              ? { depth: options.maxDepth + 2 }
              : { movetimeMs: options.movetimeMs * 2 }),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
    };
}

function repetitionKey(fen: string): string {
    return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

function incrementPosition(
    counts: ReadonlyMap<string, number>,
    fen: string
): Map<string, number> {
    const next = new Map(counts);
    const key = repetitionKey(fen);
    next.set(key, (next.get(key) ?? 0) + 1);
    return next;
}

function halfmoveClock(fen: string): number {
    const value = Number(fen.trim().split(/\s+/)[4]);
    return Number.isFinite(value) ? value : 0;
}

function terminalReason(
    chess: Chess,
    counts: ReadonlyMap<string, number>
): ContinuationStopReason | null {
    if (chess.isCheckmate()) return 'CHECKMATE';
    if (chess.isStalemate()) return 'STALEMATE';
    if (chess.isInsufficientMaterial()) return 'INSUFFICIENT_MATERIAL';
    if (halfmoveClock(chess.fen()) >= 100) return 'FIFTY_MOVE';
    if ((counts.get(repetitionKey(chess.fen())) ?? 0) >= 3) {
        return 'THREEFOLD_REPETITION';
    }
    return null;
}

type RepetitionDrawMove = {
    moveUci: string;
    nextFen: string;
};

/**
 * Stockfish and Syzygy analyze a standalone FEN, so neither can discover a
 * draw whose third occurrence depends on positions played before this node.
 * Enumerating the legal root moves is exact and naturally bounded by chess's
 * legal move count.
 */
function repetitionDrawMoves(
    chess: Chess,
    counts: ReadonlyMap<string, number>
): RepetitionDrawMove[] {
    const moves = chess.moves({ verbose: true }).slice(0, 256);
    const draws: RepetitionDrawMove[] = [];
    for (const move of moves) {
        const moveUci = `${move.from}${move.to}${move.promotion ?? ''}`;
        const nextFen = applyUci(chess.fen(), moveUci);
        if (
            nextFen &&
            (counts.get(repetitionKey(nextFen)) ?? 0) + 1 >= 3
        ) {
            draws.push({ moveUci, nextFen });
        }
    }
    return draws;
}

function parseUci(
    uci: string
): { from: string; to: string; promotion?: string } | null {
    const normalized = uci.trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)) return null;
    return {
        from: normalized.slice(0, 2),
        to: normalized.slice(2, 4),
        ...(normalized.length === 5
            ? { promotion: normalized.slice(4, 5) }
            : {}),
    };
}

function applyUci(fen: string, uci: string): string | null {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    try {
        const chess = new Chess(fen);
        const move = chess.move(parsed);
        return move ? chess.fen() : null;
    } catch {
        return null;
    }
}

function stopNode(
    fen: string,
    ply: number,
    reason: ContinuationStopReason,
    evidenceSource: VerifiedSolutionNode['evidenceSource'] = 'RULE'
): VerifiedSolutionNode {
    return {
        fen,
        ply,
        role: 'TERMINAL',
        evidenceSource,
        acceptedMovesUci: [],
        alternativesComplete: true,
        branches: [],
        stopReason: reason,
    };
}

function exactEngineLines(lines: MultiPvLine[]): MultiPvLine[] {
    return lines
        .filter(isExactEngineLine)
        .sort((left, right) => left.multipv - right.multipv);
}

function isExactEngineLine(line: MultiPvLine): boolean {
    return (
        line.score != null &&
        typeof line.pvUci?.[0] === 'string' &&
        parseUci(line.pvUci[0]!) != null
    );
}

function hasContiguousMultiPvSlots(lines: MultiPvLine[]): boolean {
    return lines.every(
        (line, index) =>
            Number.isSafeInteger(line.multipv) &&
            line.multipv === index + 1
    );
}

function canonicalRootMoveLines(lines: MultiPvLine[]): MultiPvLine[] {
    const byMove = new Map<string, MultiPvLine>();
    for (const line of lines) {
        const move = line.pvUci[0]?.trim().toLowerCase();
        if (!move || byMove.has(move)) continue;
        // Lines arrive in ascending MultiPV order. The lowest slot is the
        // canonical ranking when Stockfish repeats one root move in later
        // slots with different cumulative search metadata.
        byMove.set(move, line);
    }
    return Array.from(byMove.values());
}

function acceptedEngineLines(
    lines: MultiPvLine[],
    options: ResolvedVerifierOptions
): MultiPvLine[] {
    const best = lines[0];
    if (!best) return [];
    return lines.filter((line) => {
        const loss = evaluationLoss(
            { score: best.score, wdl: best.wdl },
            { score: line.score, wdl: line.wdl }
        );
        // The helper is expressed as a minimum-loss predicate; negate that
        // predicate with an epsilon to retain equality at the acceptance edge.
        return !qualifiesEvaluationLoss(loss, {
            minWinningChanceLoss:
                options.maxAcceptedWinningChanceLoss + Number.EPSILON,
            fallbackMinCpLoss:
                options.fallbackMaxAcceptedCpLoss + Number.EPSILON,
        });
    });
}

function tablebaseRank(wdl: TablebaseWdl): number {
    if (wdl === 'WIN') return 3;
    if (wdl === 'DRAW') return 2;
    if (wdl === 'LOSS') return 1;
    return 0;
}

function bestTablebaseMoves(
    evidence: TablebaseEvidence
): TablebaseMoveEvidence[] {
    const known = evidence.moves.filter((move) => move.wdl !== 'UNKNOWN');
    const bestRank = Math.max(0, ...known.map((move) => tablebaseRank(move.wdl)));
    return known.filter((move) => tablebaseRank(move.wdl) === bestRank);
}

function engineEvaluation(line: MultiPvLine): VerifiedMoveEvaluation {
    return {
        source: 'ENGINE',
        score: line.score,
        ...(line.wdl ? { wdl: line.wdl } : {}),
        ...(line.depth != null ? { depth: line.depth } : {}),
        ...(line.nodes != null ? { nodes: line.nodes } : {}),
    };
}

function tablebaseEvaluation(
    move: TablebaseMoveEvidence
): VerifiedMoveEvaluation {
    return {
        source: 'TABLEBASE',
        wdl: move.wdl,
        categoryAfterMove: move.categoryAfterMove,
        ...(move.dtz != null ? { dtz: move.dtz } : {}),
        ...(move.preciseDtz != null
            ? { preciseDtz: move.preciseDtz }
            : {}),
    };
}

function ruleDrawEvaluation(): VerifiedMoveEvaluation {
    return {
        source: 'RULE',
        outcome: 'DRAW',
        reason: 'THREEFOLD_REPETITION',
    };
}

const RULE_DRAW_ENGINE_EVIDENCE = {
    score: { type: 'cp', value: 0 } as const,
    wdl: { win: 0, draw: 1_000, loss: 0 },
};

function engineLineWithinRuleDrawTolerance(
    line: MultiPvLine,
    options: ResolvedVerifierOptions
): boolean {
    return isWithinEvaluationLoss(
        evaluationLoss(RULE_DRAW_ENGINE_EVIDENCE, {
            score: line.score,
            wdl: line.wdl,
        }),
        {
            maxWinningChanceLoss:
                options.maxAcceptedWinningChanceLoss,
            fallbackMaxCpLoss: options.fallbackMaxAcceptedCpLoss,
        }
    );
}

function engineLineWithinBestEngineTolerance(
    best: MultiPvLine | undefined,
    line: MultiPvLine,
    options: ResolvedVerifierOptions
): boolean {
    if (!best) return false;
    return isWithinEvaluationLoss(
        evaluationLoss(
            { score: best.score, wdl: best.wdl },
            { score: line.score, wdl: line.wdl }
        ),
        {
            maxWinningChanceLoss:
                options.maxAcceptedWinningChanceLoss,
            fallbackMaxCpLoss: options.fallbackMaxAcceptedCpLoss,
        }
    );
}

function ruleDrawOutranksEngine(
    best: MultiPvLine | undefined,
): boolean {
    if (!best) return true;
    const chance = winningChance(best.score, best.wdl);
    if (chance != null) return chance < 0.5;
    const cp = scoreToOrderingCp(best.score);
    return cp != null && cp < 0;
}

function ruleDrawWithinBestEngineTolerance(
    best: MultiPvLine | undefined,
    options: ResolvedVerifierOptions
): boolean {
    if (!best) return true;
    return isWithinEvaluationLoss(
        evaluationLoss(
            { score: best.score, wdl: best.wdl },
            RULE_DRAW_ENGINE_EVIDENCE
        ),
        {
            maxWinningChanceLoss:
                options.maxAcceptedWinningChanceLoss,
            fallbackMaxCpLoss: options.fallbackMaxAcceptedCpLoss,
        }
    );
}

function shouldExpandEngineFrontier(args: {
    analyzed: MultiPvResult;
    requestedMultiPv: number;
    fen: string;
    repetitionMoves: RepetitionDrawMove[];
    options: ResolvedVerifierOptions;
}): boolean {
    const returned = exactEngineLines(args.analyzed.lines);
    if (
        returned.length !== args.requestedMultiPv ||
        args.analyzed.lines.some((line) => !isExactEngineLine(line)) ||
        !hasContiguousMultiPvSlots(returned) ||
        returned.some(
            (line) =>
                applyUci(
                    args.fen,
                    line.pvUci[0]!.trim().toLowerCase()
                ) == null
        )
    ) {
        return false;
    }
    const lines = canonicalRootMoveLines(returned);
    if (lines.length !== returned.length || lines.length === 0) {
        return false;
    }
    if (args.repetitionMoves.length === 0) {
        return (
            acceptanceFrontierFromMultiPv({
                lines,
                requestedMultiPv: args.requestedMultiPv,
                alternativesComplete:
                    args.analyzed.alternativesComplete,
                policy: args.options.gradingPolicy,
            }).status !== 'STABLE'
        );
    }
    const frontier = returned.at(-1);
    if (!frontier) return false;
    const engineBestIsRuleDraw = args.repetitionMoves.some(
        (move) =>
            move.moveUci ===
            lines[0]?.pvUci[0]?.trim().toLowerCase()
    );
    const ruleIsBest =
        args.repetitionMoves.length > 0 &&
        (engineBestIsRuleDraw || ruleDrawOutranksEngine(lines[0]));
    const frontierIsRuleDraw = args.repetitionMoves.some(
        (move) =>
            move.moveUci ===
            frontier.pvUci[0]?.trim().toLowerCase()
    );
    if (frontierIsRuleDraw) {
        return (
            ruleIsBest ||
            ruleDrawWithinBestEngineTolerance(
                lines[0],
                args.options
            )
        );
    }
    return ruleIsBest
        ? engineLineWithinRuleDrawTolerance(frontier, args.options)
        : engineLineWithinBestEngineTolerance(
              lines[0],
              frontier,
              args.options
          );
}

function worsenStatus(
    state: BuildState,
    status: VerificationStatus,
    diagnostic: string
) {
    const rank: Record<VerificationStatus, number> = {
        VERIFIED: 0,
        AMBIGUOUS: 1,
        UNSTABLE: 2,
        INVALID: 3,
    };
    if (rank[status] > rank[state.status]) state.status = status;
    state.diagnostics.push(diagnostic);
}

function collectBestLine(node: VerifiedSolutionNode): string[] {
    const best =
        node.branches.find((branch) => branch.best) ?? node.branches[0];
    return best
        ? [best.moveUci, ...collectBestLine(best.child)]
        : [];
}

function collectStopReasons(
    node: VerifiedSolutionNode,
    output = new Set<ContinuationStopReason>()
): Set<ContinuationStopReason> {
    if (node.stopReason) output.add(node.stopReason);
    for (const branch of node.branches) {
        collectStopReasons(branch.child, output);
    }
    return output;
}

/**
 * Verifies a bounded conditional continuation. Every user node records all
 * practical MultiPV/tablebase alternatives within the configured tolerance;
 * every opponent node follows only best defense. All emitted edges are replayed
 * through chess.js before they can enter the solution tree.
 */
export async function verifyConditionalContinuation(args: {
    fen: string;
    engine: StockfishEngine;
    tablebase?: TablebaseProvider;
    options?: ContinuationVerifierOptions;
}): Promise<ContinuationVerificationResult> {
    const options = resolvedOptions(args.options ?? {});
    const state: BuildState = {
        positionsVisited: 0,
        largestMultiPvRequested: 1,
        status: 'VERIFIED',
        diagnostics: [],
    };

    let initial: Chess;
    try {
        initial = new Chess(args.fen);
    } catch {
        const root = stopNode(args.fen, 0, 'NO_STABLE_LINE', 'NONE');
        return {
            status: 'INVALID',
            solutionShape: 'OPEN',
            root,
            acceptedMovesUci: [],
            bestLineUci: [],
            stopReasons: ['NO_STABLE_LINE'],
            bounds: {
                maxPlies: options.maxPlies,
                maxPositions: options.maxPositions,
                multiPv: options.multiPv,
                maxMultiPv: options.maxMultiPv,
                largestMultiPvRequested: 0,
                maxUserBranches: options.maxUserBranches,
                nodesPerPosition: options.nodesPerPosition,
                maxDepth: options.maxDepth,
                positionsVisited: 0,
            },
            diagnostics: ['Invalid root FEN'],
        };
    }

    let historyCounts = new Map<string, number>();
    for (const fen of options.previousFens) {
        try {
            // Validate history FENs before using their repetition keys.
            const historical = new Chess(fen);
            historyCounts = incrementPosition(historyCounts, historical.fen());
        } catch {
            // Bad optional history cannot invalidate the actual position.
        }
    }
    historyCounts = incrementPosition(historyCounts, initial.fen());

    const build = async (
        fen: string,
        ply: number,
        counts: ReadonlyMap<string, number>
    ): Promise<VerifiedSolutionNode> => {
        let chess: Chess;
        try {
            chess = new Chess(fen);
        } catch {
            worsenStatus(state, 'INVALID', `Illegal FEN at ply ${ply}`);
            return stopNode(fen, ply, 'NO_STABLE_LINE', 'NONE');
        }

        const terminal = terminalReason(chess, counts);
        if (terminal) return stopNode(fen, ply, terminal);
        if (ply >= options.maxPlies) {
            return stopNode(fen, ply, 'MAX_PLIES', 'NONE');
        }
        if (state.positionsVisited >= options.maxPositions) {
            worsenStatus(
                state,
                'AMBIGUOUS',
                `Position budget exhausted at ply ${ply}`
            );
            return stopNode(fen, ply, 'MAX_POSITIONS', 'NONE');
        }
        state.positionsVisited += 1;

        const role = ply % 2 === 0 ? 'USER' : 'OPPONENT';
        const repetitionMoves = repetitionDrawMoves(chess, counts);
        const count = pieceCountFromFen(fen);
        if (
            args.tablebase &&
            count != null &&
            count <= 7
        ) {
            let tablebase: TablebaseEvidence | null = null;
            try {
                tablebase = await args.tablebase.probe(fen, {
                    signal: options.signal,
                });
            } catch (error) {
                if (options.signal?.aborted) throw error;
                state.diagnostics.push(
                    `Tablebase unavailable at ply ${ply}; used engine fallback`
                );
            }
            const exactTablebase =
                tablebase && tablebase.wdl !== 'UNKNOWN'
                    ? tablebase
                    : null;
            if (exactTablebase) {
                if (
                    exactTablebase.terminal.checkmate ||
                    exactTablebase.terminal.stalemate ||
                    exactTablebase.terminal.insufficientMaterial
                ) {
                    const reason = exactTablebase.terminal.checkmate
                        ? 'CHECKMATE'
                        : exactTablebase.terminal.stalemate
                          ? 'STALEMATE'
                          : 'INSUFFICIENT_MATERIAL';
                    const node = stopNode(fen, ply, reason, 'TABLEBASE');
                    node.tablebase = exactTablebase;
                    return node;
                }
                const bestMoves = bestTablebaseMoves(exactTablebase);
                const bestRank = Math.max(
                    0,
                    ...bestMoves.map((move) =>
                        tablebaseRank(move.wdl)
                    )
                );
                const ruleIsBest =
                    repetitionMoves.length > 0 &&
                    bestRank < tablebaseRank('DRAW');
                const ruleMatchesBest =
                    repetitionMoves.length > 0 &&
                    bestRank === tablebaseRank('DRAW');
                if (
                    bestMoves.length > 0 ||
                    ruleIsBest ||
                    ruleMatchesBest
                ) {
                    const exactCandidates: Array<
                        | {
                              source: 'RULE';
                              move: RepetitionDrawMove;
                          }
                        | {
                              source: 'TABLEBASE';
                              move: TablebaseMoveEvidence;
                          }
                    > = ruleIsBest
                        ? [
                              ...repetitionMoves.map(
                                  (move) =>
                                      ({
                                          source: 'RULE',
                                          move,
                                      }) as const
                              ),
                          ]
                        : [
                              ...bestMoves.map(
                                  (move) =>
                                      ({
                                          source: 'TABLEBASE',
                                          move,
                                      }) as const
                              ),
                              ...(ruleMatchesBest
                                  ? repetitionMoves
                                        .filter(
                                            (ruleMove) =>
                                                !bestMoves.some(
                                                    (move) =>
                                                        move.uci ===
                                                        ruleMove.moveUci
                                                )
                                        )
                                        .map(
                                            (move) =>
                                                ({
                                                    source: 'RULE',
                                                    move,
                                                }) as const
                                        )
                                  : []),
                          ];
                    const roleCandidates =
                        role === 'USER'
                            ? exactCandidates
                            : exactCandidates.slice(0, 1);
                    const selected = roleCandidates.slice(
                        0,
                        options.maxUserBranches
                    );
                    const alternativesComplete =
                        role === 'OPPONENT' ||
                        roleCandidates.length <=
                            options.maxUserBranches;
                    if (!alternativesComplete) {
                        worsenStatus(
                            state,
                            'AMBIGUOUS',
                            `Tablebase alternatives truncated at ply ${ply}`
                        );
                    }
                    const branches: VerifiedSolutionBranch[] = [];
                    for (let index = 0; index < selected.length; index += 1) {
                        const candidate = selected[index]!;
                        const moveUci =
                            candidate.source === 'RULE'
                                ? candidate.move.moveUci
                                : candidate.move.uci;
                        const nextFen =
                            candidate.source === 'RULE'
                                ? candidate.move.nextFen
                                : applyUci(fen, moveUci);
                        if (!nextFen) {
                            worsenStatus(
                                state,
                                'INVALID',
                                `Illegal exact move ${moveUci} at ply ${ply}`
                            );
                            continue;
                        }
                        const nextCounts = incrementPosition(counts, nextFen);
                        branches.push({
                            moveUci,
                            best: index === 0,
                            evaluation:
                                candidate.source === 'RULE'
                                    ? ruleDrawEvaluation()
                                    : tablebaseEvaluation(
                                          candidate.move
                                      ),
                            child: await build(
                                nextFen,
                                ply + 1,
                                nextCounts
                            ),
                        });
                    }
                    if (branches.length === 0) {
                        worsenStatus(
                            state,
                            'INVALID',
                            `No legal tablebase move at ply ${ply}`
                        );
                        return stopNode(
                            fen,
                            ply,
                            'NO_STABLE_LINE',
                            'TABLEBASE'
                        );
                    }
                    return {
                        fen,
                        ply,
                        role,
                        evidenceSource:
                            branches[0]!.evaluation.source,
                        acceptedMovesUci:
                            role === 'USER'
                                ? branches.map((branch) => branch.moveUci)
                                : [],
                        selectedMoveUci: branches[0]!.moveUci,
                        alternativesComplete,
                        tablebase: exactTablebase,
                        branches,
                    };
                }
            }
        }

        let requestedMultiPv =
            role === 'USER' ? options.multiPv : 1;
        let analyzed: MultiPvResult | null = null;
        let analyzedMultiPv = requestedMultiPv;
        while (true) {
            let next: MultiPvResult;
            try {
                next = await args.engine.analyzeMultiPv({
                    fen,
                    multiPv: requestedMultiPv,
                    ...analysisLimit(options),
                });
            } catch (error) {
                if (options.signal?.aborted) throw error;
                if (analyzed) {
                    state.diagnostics.push(
                        `Adaptive MultiPV expansion failed at ply ${ply}: ${
                            error instanceof Error
                                ? error.message
                                : 'unknown error'
                        }`
                    );
                    break;
                }
                worsenStatus(
                    state,
                    'UNSTABLE',
                    `Engine analysis failed at ply ${ply}: ${
                        error instanceof Error
                            ? error.message
                            : 'unknown error'
                    }`
                );
                return stopNode(
                    fen,
                    ply,
                    'NO_STABLE_LINE',
                    'ENGINE'
                );
            }
            analyzed = next;
            analyzedMultiPv = requestedMultiPv;
            state.largestMultiPvRequested = Math.max(
                state.largestMultiPvRequested,
                requestedMultiPv
            );
            if (
                role !== 'USER' ||
                requestedMultiPv >= options.maxMultiPv ||
                !shouldExpandEngineFrontier({
                    analyzed,
                    requestedMultiPv,
                    fen,
                    repetitionMoves,
                    options,
                })
            ) {
                break;
            }
            requestedMultiPv = Math.min(
                options.maxMultiPv,
                Math.max(requestedMultiPv + 1, requestedMultiPv * 2)
            );
        }
        if (!analyzed) {
            worsenStatus(state, 'UNSTABLE', `No engine analysis at ply ${ply}`);
            return stopNode(fen, ply, 'NO_STABLE_LINE', 'ENGINE');
        }
        requestedMultiPv = analyzedMultiPv;
        let confirmedAcceptanceFrontier: AcceptanceFrontier | null = null;
        if (role === 'USER' && repetitionMoves.length === 0) {
            const firstFrontier = acceptanceFrontierFromMultiPv({
                lines: analyzed.lines,
                requestedMultiPv,
                alternativesComplete: analyzed.alternativesComplete,
                policy: options.gradingPolicy,
            });
            if (firstFrontier.status === 'STABLE') {
                try {
                    const confirmation =
                        await args.engine.analyzeMultiPv({
                            fen,
                            multiPv: requestedMultiPv,
                            ...confirmationAnalysisLimit(options),
                        });
                    const nextFrontier =
                        acceptanceFrontierFromMultiPv({
                            lines: confirmation.lines,
                            requestedMultiPv,
                            alternativesComplete:
                                confirmation.alternativesComplete,
                            policy: options.gradingPolicy,
                        });
                    confirmedAcceptanceFrontier =
                        confirmAcceptanceFrontier(
                            firstFrontier,
                            nextFrontier
                        );
                    analyzed = confirmation;
                    if (
                        confirmedAcceptanceFrontier.status !==
                        'STABLE'
                    ) {
                        worsenStatus(
                            state,
                            'AMBIGUOUS',
                            `Accepted-move frontier changed during confirmation at ply ${ply}`
                        );
                    }
                } catch (error) {
                    if (options.signal?.aborted) throw error;
                    confirmedAcceptanceFrontier = {
                        ...firstFrontier,
                        status: 'UNSTABLE',
                        effectiveCutoffCp: null,
                        boundaryGapCp: null,
                    };
                    worsenStatus(
                        state,
                        'UNSTABLE',
                        `Accepted-move confirmation failed at ply ${ply}`
                    );
                }
            } else {
                confirmedAcceptanceFrontier = firstFrontier;
            }
        }
        const rejectedEngineLines = analyzed.lines.filter(
            (line) => !isExactEngineLine(line)
        );
        for (const line of rejectedEngineLines) {
            worsenStatus(
                state,
                'INVALID',
                `Malformed engine line in MultiPV slot ${String(line.multipv)} at ply ${ply}`
            );
        }
        const returnedExactLines = exactEngineLines(analyzed.lines);
        const validMultiPvSlots =
            hasContiguousMultiPvSlots(returnedExactLines) &&
            returnedExactLines.length <= requestedMultiPv;
        if (!validMultiPvSlots && returnedExactLines.length > 0) {
            worsenStatus(
                state,
                'INVALID',
                `Non-contiguous MultiPV slots at ply ${ply}`
            );
        }
        const illegalExactLines = returnedExactLines.filter(
            (line) =>
                applyUci(
                    fen,
                    line.pvUci[0]!.trim().toLowerCase()
                ) == null
        );
        for (const line of illegalExactLines) {
            worsenStatus(
                state,
                'INVALID',
                `Illegal engine move ${line.pvUci[0]!.trim().toLowerCase()} at ply ${ply}`
            );
        }
        const rawExactLines = returnedExactLines.filter(
            (line) => !illegalExactLines.includes(line)
        );
        const lines = canonicalRootMoveLines(rawExactLines);
        const duplicateRootMoves =
            rawExactLines.length !== lines.length;
        if (duplicateRootMoves) {
            worsenStatus(
                state,
                'AMBIGUOUS',
                `Duplicate MultiPV root move at ply ${ply}`
            );
        }
        if (lines.length === 0) {
            worsenStatus(
                state,
                'UNSTABLE',
                `No exact engine line at ply ${ply}`
            );
            return stopNode(
                fen,
                ply,
                'NO_STABLE_LINE',
                'ENGINE'
            );
        }
        const engineBestIsExactRuleDraw = repetitionMoves.some(
            (move) =>
                move.moveUci ===
                lines[0]?.pvUci[0]?.trim().toLowerCase()
        );
        const ruleIsBest =
            repetitionMoves.length > 0 &&
            (engineBestIsExactRuleDraw ||
                ruleDrawOutranksEngine(lines[0]));
        const ruleIsAccepted =
            repetitionMoves.length > 0 &&
            ruleDrawWithinBestEngineTolerance(
                lines[0],
                options
            );
        const engineAcceptanceFrontier =
            role === 'USER' && repetitionMoves.length === 0
                ? confirmedAcceptanceFrontier ??
                  acceptanceFrontierFromMultiPv({
                      lines: rawExactLines,
                      requestedMultiPv,
                      alternativesComplete:
                          analyzed.alternativesComplete,
                      policy: options.gradingPolicy,
                  })
                : null;
        const acceptedEngineMoveSet = new Set(
            engineAcceptanceFrontier?.moves.map(
                (move) => move.moveUci
            ) ?? []
        );
        const selectedEngineLines =
            role === 'USER'
                ? ruleIsBest
                    ? lines.filter((line) =>
                          engineLineWithinRuleDrawTolerance(
                              line,
                              options
                          )
                      )
                    : engineAcceptanceFrontier
                      ? lines.filter((line) =>
                            acceptedEngineMoveSet.has(
                                line.pvUci[0]
                                    ?.trim()
                                    .toLowerCase() ?? ''
                            )
                        )
                      : acceptedEngineLines(lines, options)
                : lines.slice(0, 1);
        const engineCandidates = selectedEngineLines
            .filter(
                (line) =>
                    !repetitionMoves.some(
                        (move) =>
                            move.moveUci ===
                            line.pvUci[0]
                                ?.trim()
                                .toLowerCase()
                    )
            )
            .map(
                (line) =>
                    ({ source: 'ENGINE', line }) as const
            );
        const ruleCandidates = repetitionMoves.map(
                (move) =>
                    ({ source: 'RULE', move }) as const
        );
        const selected: Array<
            | { source: 'RULE'; move: RepetitionDrawMove }
            | { source: 'ENGINE'; line: MultiPvLine }
        > =
            role === 'OPPONENT'
                ? ruleIsBest
                    ? ruleCandidates.slice(0, 1)
                    : engineCandidates.slice(0, 1)
                : ruleIsBest
                  ? [...ruleCandidates, ...engineCandidates]
                  : [
                        ...engineCandidates,
                        ...(ruleIsAccepted
                            ? ruleCandidates
                            : []),
                    ];
        if (selected.length === 0) {
            worsenStatus(
                state,
                'UNSTABLE',
                `No exact engine line at ply ${ply}`
            );
            return stopNode(fen, ply, 'NO_STABLE_LINE', 'ENGINE');
        }

        const bounded =
            role === 'USER'
                ? selected.slice(0, options.maxUserBranches)
                : selected.slice(0, 1);
        const frontierLine = rawExactLines[rawExactLines.length - 1];
        const frontierIsExactRuleDraw =
            !!frontierLine &&
            repetitionMoves.some(
                (move) =>
                    move.moveUci ===
                    frontierLine.pvUci[0]
                        ?.trim()
                        .toLowerCase()
            );
        const frontierWithinTolerance =
            !!frontierLine &&
            (frontierIsExactRuleDraw
                ? ruleIsBest ||
                  ruleDrawWithinBestEngineTolerance(
                      lines[0],
                      options
                  )
                : ruleIsBest
                  ? engineLineWithinRuleDrawTolerance(
                        frontierLine,
                        options
                    )
                  : engineLineWithinBestEngineTolerance(
                        lines[0],
                        frontierLine,
                        options
                    ));
        const shortFrontier =
            rawExactLines.length < requestedMultiPv;
        const frontierExhausted =
            shortFrontier
                ? analyzed.alternativesComplete === true
                : !frontierWithinTolerance;
        const alternativesComplete =
            rejectedEngineLines.length === 0 &&
            validMultiPvSlots &&
            illegalExactLines.length === 0 &&
            !duplicateRootMoves &&
            analyzed.alternativesComplete !== false &&
            (role === 'OPPONENT' ||
                (selected.length <= options.maxUserBranches &&
                    (engineAcceptanceFrontier
                        ? engineAcceptanceFrontier.status ===
                          'STABLE'
                        : frontierExhausted)));
        if (!alternativesComplete) {
            worsenStatus(
                state,
                'AMBIGUOUS',
                `MultiPV alternative frontier remains open at ply ${ply}`
            );
        }

        const branches: VerifiedSolutionBranch[] = [];
        for (let index = 0; index < bounded.length; index += 1) {
            const candidate = bounded[index]!;
            const moveUci =
                candidate.source === 'RULE'
                    ? candidate.move.moveUci
                    : candidate.line.pvUci[0]!
                          .trim()
                          .toLowerCase();
            const nextFen =
                candidate.source === 'RULE'
                    ? candidate.move.nextFen
                    : applyUci(fen, moveUci);
            if (!nextFen) {
                worsenStatus(
                    state,
                    'INVALID',
                    `Illegal engine move ${moveUci} at ply ${ply}`
                );
                continue;
            }
            const nextCounts = incrementPosition(counts, nextFen);
            branches.push({
                moveUci,
                best: index === 0,
                evaluation:
                    candidate.source === 'RULE'
                        ? ruleDrawEvaluation()
                        : engineEvaluation(candidate.line),
                child: await build(nextFen, ply + 1, nextCounts),
            });
        }
        if (branches.length === 0) {
            worsenStatus(
                state,
                'INVALID',
                `No legal continuation at ply ${ply}`
            );
            return stopNode(fen, ply, 'NO_STABLE_LINE', 'ENGINE');
        }
        return {
            fen,
            ply,
            role,
            evidenceSource: branches[0]!.evaluation.source,
            acceptedMovesUci:
                role === 'USER'
                    ? branches.map((branch) => branch.moveUci)
                    : [],
            selectedMoveUci: branches[0]!.moveUci,
            alternativesComplete,
            ...(engineAcceptanceFrontier
                ? {
                      acceptanceFrontier:
                          engineAcceptanceFrontier,
                  }
                : {}),
            branches,
        };
    };

    const root = await build(initial.fen(), 0, historyCounts);
    const acceptedMovesUci = root.acceptedMovesUci;
    const bestLineUci = collectBestLine(root);
    if (bestLineUci.length === 0 && !root.stopReason) {
        worsenStatus(state, 'UNSTABLE', 'Verifier produced no best line');
    }

    let engineIdentity: EngineIdentity | undefined;
    try {
        engineIdentity = await args.engine.getIdentity?.();
    } catch {
        state.diagnostics.push('Engine identity unavailable');
    }

    const solutionShape: SolutionShape =
        !root.alternativesComplete || acceptedMovesUci.length === 0
            ? 'OPEN'
            : acceptedMovesUci.length === 1
              ? 'UNIQUE'
              : 'MULTIPLE';

    return {
        status: state.status,
        solutionShape,
        root,
        acceptedMovesUci,
        bestLineUci,
        stopReasons: Array.from(collectStopReasons(root)).sort(),
        ...(engineIdentity ? { engineIdentity } : {}),
        bounds: {
            maxPlies: options.maxPlies,
            maxPositions: options.maxPositions,
            multiPv: options.multiPv,
            maxMultiPv: options.maxMultiPv,
            largestMultiPvRequested:
                state.largestMultiPvRequested,
            maxUserBranches: options.maxUserBranches,
            nodesPerPosition: options.nodesPerPosition,
            maxDepth: options.maxDepth,
            positionsVisited: state.positionsVisited,
        },
        diagnostics: state.diagnostics,
    };
}
