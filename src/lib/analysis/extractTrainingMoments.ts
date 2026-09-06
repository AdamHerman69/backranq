import { Chess, type Move } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import type {
    EvalResult,
    MultiPvLine,
    MultiPvResult,
    Score,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import {
    type AnalyzedMove,
    type GameAnalysis,
    classifyMove,
    lichessGameAccuracy,
    lichessMoveAccuracyFromCps,
} from '@/lib/analysis/classification';
import {
    type EvaluationLoss,
    evaluationLoss,
    negateScore,
    reverseWdl,
    scoreToOrderingCp,
    winningChance,
} from '@/lib/analysis/evaluation';
import {
    verifyConditionalContinuation,
    type ContinuationVerificationResult,
    type VerifiedMoveEvaluation,
    type VerifiedSolutionNode,
} from '@/lib/analysis/continuationVerifier';
import type { TablebaseProvider } from '@/lib/analysis/tablebase';
import type {
    AcceptanceFrontier,
    GradingPolicyV3,
    PovScore,
    SolutionMoveAssessmentInput,
    SolutionRevisionInput,
    TrainingLessonKind,
    TrainingMomentCandidate,
    TrainingSourceKind,
} from '@/lib/training/contracts';
import {
    canonicalSolutionSemantics,
    stableCanonicalStringify as stableTrainingStringify,
} from '@/lib/training/contracts';
import { sha256Hex } from '@/lib/crypto/sha256';
import { normalizeGradingPolicy } from '@/lib/training/config';
import { acceptanceFrontierFromMultiPv } from '@/lib/training/acceptanceFrontier';
import {
    appendAssessmentHistory,
    MAX_ASSESSMENT_POSITION_HISTORY,
} from '@/lib/training/assessmentIdentity';
import {
    metricsFromMatchedOutcomeEvidence,
    engineWdlChance,
} from '@/lib/training/gradingEvidence';
import {
    gradeTrainingMove,
    type TrainingMoveMetrics,
} from '@/lib/training/grader';
import {
    ruleTerminalEvaluation,
    claimableDraw,
} from '@/lib/analysis/ruleEvaluation';
import { createExtractionConfigSnapshot } from '@/lib/analysis/extractionConfig';
import {
    emptyExtractionReasonCounts,
    type AdaptiveConfirmationEvidence,
    type TrainingDecisionReceipt,
} from '@/lib/analysis/extractionReceipt';

type MistakeSeverity = 'small' | 'medium' | 'big';

export type TrainingMomentExtractionOptions = {
    movetimeMs?: number;
    /**
     * Preferred deterministic budget per position. Defaults to 100k nodes.
     * Set to null to use a wall-time analysis budget.
     */
    nodesPerPosition?: number | null;
    /** Optional depth budget used only when nodesPerPosition is null. */
    maxDepth?: number | null;
    /** Safety watchdog independent of the analysis-quality budget. */
    engineTimeoutMs?: number;
    /** Broad candidate signal; final quality uses the shared grading policy. */
    minWinningChanceLoss?: number; // default 0.03
    /** Independent cp candidate signal, including saturated WDL positions. */
    fallbackMinCpLoss?: number; // default 30
    /** Versioned grading tolerance persisted with each solution. */
    gradingPolicy?: GradingPolicyV3;
    /** How many plies into the PV to look for tactical moves. Defaults to 4. */
    themeLookaheadPlies?: number;

    /**
     * Re-evaluate candidate moments at higher depth to confirm they hold up.
     * Adds paired root/reference evidence. Only a changed mistake conclusion,
     * incompatible outcome evidence or a relevant quality boundary requires escalation.
     * A deterministic 200k-node confirmation is used by default.
     */
    confirmMovetimeMs?: number | null;
    /**
     * Preferred deterministic budget for paired confirmation. Set null to use
     * the configured depth or time budget instead of node limits.
     */
    confirmNodes?: number | null;
    /**
     * Hard cap for adaptive confirmation. When omitted it is derived as four
     * times confirmNodes, bounded to 20m nodes.
     */
    maxConfirmationNodes?: number | null;

    /** Practical alternatives and played responses use one outcome tolerance. */
    multiPv?: number; // initial frontier, default 5
    maxMultiPv?: number; // adaptive frontier cap, default 16
    maxAcceptedMoves?: number; // default 16

    /** Bounded conditional verification is enabled by default. */
    verifyContinuations?: boolean;
    /**
     * Defaults to one user decision plus the opponent's reply (2 plies).
     * Larger values permit independently assessed further USER nodes; optional
     * continuation failure never invalidates the confirmed root.
     */
    verificationMaxPlies?: number;
    verificationMaxPositions?: number;
    verificationNodesPerPosition?: number | null;
    verificationMaxDepth?: number | null;

    /**
     * If true, also return move-by-move analysis with classifications for each game.
     * This captures eval data for all analyzed moves, not just training moments.
     * Defaults to false.
     */
    returnAnalysis?: boolean;
};

export function isLandingReadyTrainingMoment(
    moment: TrainingMomentCandidate,
): boolean {
    return (
        moment.solution.trainable &&
        moment.solution.verificationStatus === 'VERIFIED' &&
        moment.solution.acceptanceFrontier.status === 'STABLE' &&
        moment.solution.acceptedMovesUci.length > 0 &&
        moment.solution.bestLineUci.length > 0
    );
}

export type LandingDecisionCandidate = {
    decisionPly: number;
    loss: EvaluationLoss;
};

type LandingSearch =
    | {
          mode: 'SCOUT';
          onCandidate: (candidate: LandingDecisionCandidate) => void;
      }
    | { mode: 'VERIFY'; decisionPly: number };

/**
 * Authoritative training-moment extraction result.
 */
export type TrainingMomentExtractionResult = {
    moments: TrainingMomentCandidate[];
    manifests: ExtractionCompletionManifest[];
    configSnapshot: Record<string, unknown>;
    configHash: string;
    /**
     * Present only when a resumable single-game extraction deliberately yields
     * between plies. The caller must persist the checkpoint before scheduling
     * another worker slice.
     */
    checkpoint?: TrainingMomentExtractionCheckpoint;
    /**
     * Move-by-move analysis for each game, keyed by game ID.
     * Only populated if options.returnAnalysis is true.
     */
    analysis?: Map<string, GameAnalysis>;
};

export type TrainingMomentExtractionCheckpoint = {
    version: 1;
    gameId: string;
    sourceGameId: string;
    sourcePgnHash: string;
    configHash: string;
    nextPly: number;
    expectedPlies: number;
    moments: TrainingMomentCandidate[];
    gameAnalysis: AnalyzedMove[];
    whiteMoveAccuracies: number[];
    blackMoveAccuracies: number[];
    extractionErrors: string[];
    decisionReceipts: Array<[number, TrainingDecisionReceipt]>;
    previousMoveLoss?: EvaluationLoss;
    pendingScan?: boolean;
    pendingConfirmation?: ConfirmationCandidateResult & {
        confirmationEvidence?: AdaptiveConfirmationEvidence;
    };
    pendingOpponentError?: boolean;
    scanEvidence?: Array<{
        fen: string;
        previousFens: string[];
        evaluation: EvalResult;
    }>;
};

export type ExtractionCompletionManifest = {
    version: 1;
    scope: 'FULL_GAME' | 'TARGETED_DECISION' | 'SCOUT';
    scanComplete: boolean;
    extractionComplete: boolean;
    decisionOutcomes: Array<{
        decisionPly: number;
        status: 'CONFIRMED_MISTAKE' | 'NOT_A_MISTAKE' | 'UNRESOLVED';
        reason: string;
    }>;
    complete: boolean;
    sourceGameId: string;
    sourcePgnHash: string;
    scannedPlies: number;
    expectedPlies: number;
    termination:
        | 'COMPLETED'
        | 'ANALYSIS_INCOMPLETE'
        | 'SOURCE_REPLAY_STOPPED'
        | 'INVALID_SOURCE'
        | 'USER_SIDE_UNRESOLVED';
    errors: string[];
};

function canonicalSourceGameId(
    mapping:
        | ReadonlyMap<string, string>
        | Readonly<Record<string, string>>
        | undefined,
    gameId: string,
): string {
    if (!mapping) return gameId;
    if (typeof (mapping as ReadonlyMap<string, string>).get === 'function') {
        return (mapping as ReadonlyMap<string, string>).get(gameId) ?? gameId;
    }
    return (mapping as Readonly<Record<string, string>>)[gameId] ?? gameId;
}

function scoreToCp(score: Score | null): number | null {
    return scoreToOrderingCp(score);
}

function parseUci(
    uci: string,
): { from: string; to: string; promotion?: string } | null {
    const s = uci.trim();
    if (s.length < 4) return null;
    const from = s.slice(0, 2);
    const to = s.slice(2, 4);
    const promotion = s.length >= 5 ? s[4] : undefined;
    return { from, to, promotion };
}

/**
 * Check if a UCI move is tactical (check, capture, or promotion).
 * Requires a chess.js instance set to the position BEFORE the move.
 */
export function tacticalMoveFacts(
    chess: Chess,
    uciMove: string,
): { isCheck: boolean; isCapture: boolean; isPromotion: boolean } {
    const parsed = parseUci(uciMove);
    if (!parsed)
        return { isCheck: false, isCapture: false, isPromotion: false };

    const isPromotion = !!parsed.promotion;

    // Apply the move to detect both ordinary and en-passant captures.
    let isCapture = false;
    let isCheck = false;
    try {
        const clone = new Chess(chess.fen());
        const move = clone.move({
            from: parsed.from,
            to: parsed.to,
            promotion: parsed.promotion,
        });
        isCapture = !!move?.captured;
        isCheck = clone.inCheck();
    } catch {
        // Invalid move, not tactical
    }

    return { isCheck, isCapture, isPromotion };
}

function sideToMoveFromFen(fen: string): 'w' | 'b' {
    const parts = fen.split(' ');
    return (parts[1] === 'b' ? 'b' : 'w') as 'w' | 'b';
}

function userColorForGame(game: NormalizedGame): 'w' | 'b' | null {
    return resolveGameAnalysisProvenance(game)?.userColor ?? null;
}

function nonKingPieceCountFromFen(fen: string): number {
    const placement = fen.split(' ')[0] ?? '';
    let n = 0;
    for (let i = 0; i < placement.length; i++) {
        const c = placement[i]!;
        if (c >= 'A' && c <= 'Z') {
            if (c !== 'K') n++;
        } else if (c >= 'a' && c <= 'z') {
            if (c !== 'k') n++;
        }
    }
    return n;
}

function materialByColorFromFen(fen: string): { w: number; b: number } {
    const c = new Chess(fen);
    const board = c.board();
    const val: Record<string, number> = {
        p: 1,
        n: 3,
        b: 3,
        r: 5,
        q: 9,
        k: 0,
    };
    let w = 0;
    let b = 0;
    for (const row of board) {
        for (const sq of row) {
            if (!sq) continue;
            const v = val[sq.type] ?? 0;
            if (sq.color === 'w') w += v;
            else b += v;
        }
    }
    return { w, b };
}

function queenCountFromFen(fen: string): number {
    const placement = fen.split(' ')[0] ?? '';
    let n = 0;
    for (let i = 0; i < placement.length; i++) {
        const c = placement[i]!;
        if (c === 'q' || c === 'Q') n++;
    }
    return n;
}

function phaseFromPosition(args: {
    fen: string;
    ply: number;
}): 'opening' | 'middlegame' | 'endgame' {
    // Heuristic buckets:
    // - opening: early in the game
    // - endgame: low material / simplified (often no queens)
    // - else: middlegame
    const plyThresholdForOpening = 24; // ~12 moves
    if (args.ply < plyThresholdForOpening) return 'opening';

    const nonKing = nonKingPieceCountFromFen(args.fen);
    const mat = materialByColorFromFen(args.fen);
    const totalMat = mat.w + mat.b;
    const queens = queenCountFromFen(args.fen);

    const endgameByMaterial =
        nonKing <= 10 || totalMat <= 22 || (queens === 0 && nonKing <= 14);

    return endgameByMaterial ? 'endgame' : 'middlegame';
}

function applyUciPlies(opts: {
    fen: string;
    uciLine: string[];
    maxPlies: number;
}): { fen: string; pliesApplied: number } {
    const c = new Chess(opts.fen);
    let applied = 0;
    for (let i = 0; i < Math.min(opts.uciLine.length, opts.maxPlies); i++) {
        const m = parseUci(opts.uciLine[i]!);
        if (!m) break;
        try {
            const ok = c.move({
                from: m.from,
                to: m.to,
                promotion: m.promotion,
            });
            if (!ok) break;
            applied++;
        } catch {
            break;
        }
    }
    return { fen: c.fen(), pliesApplied: applied };
}

// ─────────────────────────────────────────────────────────────────────────────
// Motif tagging (lightweight, deterministic, PV-based)
// ─────────────────────────────────────────────────────────────────────────────

type Board2d = ReturnType<Chess['board']>;
type PieceColor = 'w' | 'b';
type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

function otherColor(c: PieceColor): PieceColor {
    return c === 'w' ? 'b' : 'w';
}

function squareToXY(square: string): { x: number; y: number } | null {
    const s = (square ?? '').trim();
    if (s.length !== 2) return null;
    const file = s.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = s.charCodeAt(1) - '1'.charCodeAt(0);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return { x: file, y: rank };
}

function xyToSquare(x: number, y: number): string | null {
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return `${String.fromCharCode('a'.charCodeAt(0) + x)}${y + 1}`;
}

function pieceAt(board: Board2d, x: number, y: number) {
    // chess.board() is rank 8..1 (top to bottom). Our y is rank 1..8 (bottom to top).
    const row = 7 - y;
    const col = x;
    return board[row]?.[col] ?? null;
}

function findKingSquare(board: Board2d, color: PieceColor): string | null {
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const p = board[row]?.[col];
            if (!p) continue;
            if (p.type === 'k' && p.color === color) {
                const file = String.fromCharCode('a'.charCodeAt(0) + col);
                const rank = String(8 - row);
                return `${file}${rank}`;
            }
        }
    }
    return null;
}

function rayClear(
    board: Board2d,
    fx: number,
    fy: number,
    tx: number,
    ty: number,
) {
    const dx = Math.sign(tx - fx);
    const dy = Math.sign(ty - fy);
    if (dx === 0 && dy === 0) return true;
    let x = fx + dx;
    let y = fy + dy;
    while (x !== tx || y !== ty) {
        if (pieceAt(board, x, y)) return false;
        x += dx;
        y += dy;
    }
    return true;
}

function pieceAttacksSquare(
    board: Board2d,
    from: string,
    piece: { type: PieceType; color: PieceColor },
    target: string,
): boolean {
    const f = squareToXY(from);
    const t = squareToXY(target);
    if (!f || !t) return false;
    const dx = t.x - f.x;
    const dy = t.y - f.y;

    switch (piece.type) {
        case 'p': {
            const dir = piece.color === 'w' ? 1 : -1;
            return dy === dir && (dx === 1 || dx === -1);
        }
        case 'n': {
            const adx = Math.abs(dx);
            const ady = Math.abs(dy);
            return (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
        }
        case 'k': {
            return Math.max(Math.abs(dx), Math.abs(dy)) === 1;
        }
        case 'b': {
            if (Math.abs(dx) !== Math.abs(dy)) return false;
            return rayClear(board, f.x, f.y, t.x, t.y);
        }
        case 'r': {
            if (!(dx === 0 || dy === 0)) return false;
            return rayClear(board, f.x, f.y, t.x, t.y);
        }
        case 'q': {
            const diag = Math.abs(dx) === Math.abs(dy);
            const ortho = dx === 0 || dy === 0;
            if (!diag && !ortho) return false;
            return rayClear(board, f.x, f.y, t.x, t.y);
        }
        default:
            return false;
    }
}

function isSquareAttackedByColor(
    board: Board2d,
    target: string,
    attackerColor: PieceColor,
): boolean {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const p = pieceAt(board, x, y);
            if (!p) continue;
            if (p.color !== attackerColor) continue;
            const from = xyToSquare(x, y);
            if (!from) continue;
            if (
                pieceAttacksSquare(
                    board,
                    from,
                    { type: p.type as PieceType, color: p.color as PieceColor },
                    target,
                )
            ) {
                return true;
            }
        }
    }
    return false;
}

function firstTwoPiecesOnRay(
    board: Board2d,
    fx: number,
    fy: number,
    dx: number,
    dy: number,
): {
    first: {
        x: number;
        y: number;
        piece: { type: PieceType; color: PieceColor };
    };
    second: {
        x: number;
        y: number;
        piece: { type: PieceType; color: PieceColor };
    } | null;
} | null {
    let x = fx + dx;
    let y = fy + dy;
    let first: {
        x: number;
        y: number;
        piece: { type: PieceType; color: PieceColor };
    } | null = null;
    while (x >= 0 && x <= 7 && y >= 0 && y <= 7) {
        const p = pieceAt(board, x, y);
        if (p) {
            if (!first) {
                first = {
                    x,
                    y,
                    piece: {
                        type: p.type as PieceType,
                        color: p.color as PieceColor,
                    },
                };
            } else {
                return {
                    first,
                    second: {
                        x,
                        y,
                        piece: {
                            type: p.type as PieceType,
                            color: p.color as PieceColor,
                        },
                    },
                };
            }
        }
        x += dx;
        y += dy;
    }
    return first ? { first, second: null } : null;
}

function isCheckmatePosition(chess: Chess): boolean {
    // chess.js has different method names across versions; this is reliable.
    return chess.inCheck() && chess.moves().length === 0;
}

function motifTagsFromPv(args: {
    startFen: string;
    pvUci: string[] | null | undefined;
    score: Score | null;
}): string[] {
    const tags = new Set<string>();
    const pv = args.pvUci ?? [];
    if (pv.length === 0) return [];

    type MoveExt = Move & { captured?: string; promotion?: string };

    // Mate tags (from engine score) – keep low-cardinality.
    if (args.score?.type === 'mate' && args.score.value > 0) {
        tags.add('mate');
        const n = Math.abs(Math.trunc(args.score.value));
        if (Number.isFinite(n) && n > 0 && n <= 5) tags.add(`mateIn${n}`);
        else tags.add('mateInN');
    }

    // Sacrifice (very approximate): early material drop while still clearly
    // winning at the training position.
    const mover = sideToMoveFromFen(args.startFen);
    const baseMat = materialByColorFromFen(args.startFen)[mover];
    const after2 = applyUciPlies({
        fen: args.startFen,
        uciLine: pv,
        maxPlies: 2,
    });
    if (after2.pliesApplied >= 1) {
        const mat2 = materialByColorFromFen(after2.fen)[mover];
        const drop = baseMat - mat2;
        const startCp = scoreToCp(args.score);
        const isClearlyWinning =
            (startCp != null && startCp >= 150) ||
            (args.score?.type === 'mate' && args.score.value > 0);
        if (drop >= 3 && isClearlyWinning) tags.add('sacrifice');
    }

    const chess = new Chess(args.startFen);
    const maxPlies = Math.min(pv.length, 8);

    // Track "mate in N" from PV too (in case score is cp but PV ends in mate).
    for (let i = 0; i < maxPlies; i++) {
        const uci = pv[i];
        if (!uci) break;

        const beforeFen = chess.fen();
        const before = new Chess(beforeFen);
        const beforeBoard = before.board();
        const moverColor = before.turn() as PieceColor;
        const enemyColor = otherColor(moverColor);

        const parsed = parseUci(uci);
        if (!parsed) break;

        let mv: Move | null = null;
        try {
            mv = chess.move({
                from: parsed.from,
                to: parsed.to,
                promotion: parsed.promotion,
            });
        } catch {
            break;
        }
        if (!mv) break;

        const afterBoard = chess.board();
        const mvExt = mv as MoveExt;
        const isCapture = !!mvExt.captured; // includes en passant
        const isPromotion = !!mvExt.promotion;
        const isCheck = chess.inCheck();

        // Simple surface tags based on the best move (first ply).
        if (i === 0) {
            if (isCheck) tags.add('check');
            if (isCapture) tags.add('capture');
            if (isPromotion) tags.add('promotion');
            if (!isCheck && !isCapture && !isPromotion) tags.add('quietMove');
        }

        // Only inspect solver's moves for motifs (plies 0,2,4,...) and keep it cheap.
        const isSolverMove = i % 2 === 0;
        const withinMotifWindow = i <= 5;
        if (isSolverMove && withinMotifWindow) {
            const movedPieceType =
                (mv.piece as PieceType | undefined) ?? undefined;
            const movedTo = mv.to ?? undefined;
            if (movedPieceType && movedTo) {
                // Fork: moved piece attacks >=2 valuable enemy pieces (or king+piece) after the move.
                const valuable = new Set<PieceType>(['k', 'q', 'r', 'b', 'n']);
                let attackedValuables = 0;
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        const p = pieceAt(afterBoard, x, y);
                        if (!p) continue;
                        if (p.color !== enemyColor) continue;
                        if (!valuable.has(p.type as PieceType)) continue;
                        const sq = xyToSquare(x, y);
                        if (!sq) continue;
                        if (
                            pieceAttacksSquare(
                                afterBoard,
                                movedTo,
                                { type: movedPieceType, color: moverColor },
                                sq,
                            )
                        ) {
                            attackedValuables++;
                            if (attackedValuables >= 2) break;
                        }
                    }
                    if (attackedValuables >= 2) break;
                }
                if (attackedValuables >= 2) tags.add('fork');

                // Pin / skewer (line pieces only).
                if (
                    movedPieceType === 'b' ||
                    movedPieceType === 'r' ||
                    movedPieceType === 'q'
                ) {
                    const dirs: { dx: number; dy: number }[] = [];
                    if (movedPieceType === 'b' || movedPieceType === 'q') {
                        dirs.push(
                            { dx: 1, dy: 1 },
                            { dx: 1, dy: -1 },
                            { dx: -1, dy: 1 },
                            { dx: -1, dy: -1 },
                        );
                    }
                    if (movedPieceType === 'r' || movedPieceType === 'q') {
                        dirs.push(
                            { dx: 1, dy: 0 },
                            { dx: -1, dy: 0 },
                            { dx: 0, dy: 1 },
                            { dx: 0, dy: -1 },
                        );
                    }
                    const mxy = squareToXY(movedTo);
                    if (mxy) {
                        for (const d of dirs) {
                            const ray = firstTwoPiecesOnRay(
                                afterBoard,
                                mxy.x,
                                mxy.y,
                                d.dx,
                                d.dy,
                            );
                            if (!ray?.first) continue;
                            const first = ray.first;
                            const second = ray.second;
                            if (
                                first.piece.color === enemyColor &&
                                second?.piece?.color === enemyColor
                            ) {
                                if (second.piece.type === 'k') tags.add('pin');
                            }
                            if (
                                first.piece.color === enemyColor &&
                                first.piece.type === 'k' &&
                                second?.piece?.color === enemyColor
                            ) {
                                const skewTarget = second.piece.type;
                                if (skewTarget === 'q' || skewTarget === 'r')
                                    tags.add('skewer');
                            }
                        }
                    }
                }

                // Discovered check: opponent is in check, but moved piece is NOT the one giving it,
                // and the king was not already attacked before the move.
                const enemyKingAfter = findKingSquare(afterBoard, enemyColor);
                if (enemyKingAfter && isCheck) {
                    const wasAttackedBefore = isSquareAttackedByColor(
                        beforeBoard,
                        enemyKingAfter,
                        moverColor,
                    );
                    const movedGivesCheck = pieceAttacksSquare(
                        afterBoard,
                        movedTo,
                        { type: movedPieceType, color: moverColor },
                        enemyKingAfter,
                    );
                    if (!wasAttackedBefore && !movedGivesCheck) {
                        const attackedAfter = isSquareAttackedByColor(
                            afterBoard,
                            enemyKingAfter,
                            moverColor,
                        );
                        if (attackedAfter) tags.add('discoveredCheck');
                    }
                }

                // Discovered attack (approx): an enemy queen/rook becomes newly attacked by some other piece.
                // We only tag once per moment to keep tags stable/low.
                if (!tags.has('discoveredAttack')) {
                    const targets: string[] = [];
                    for (let y = 0; y < 8; y++) {
                        for (let x = 0; x < 8; x++) {
                            const p = pieceAt(afterBoard, x, y);
                            if (!p) continue;
                            if (p.color !== enemyColor) continue;
                            if (p.type !== 'q' && p.type !== 'r') continue;
                            const sq = xyToSquare(x, y);
                            if (sq) targets.push(sq);
                        }
                    }
                    for (const sq of targets) {
                        const was = isSquareAttackedByColor(
                            beforeBoard,
                            sq,
                            moverColor,
                        );
                        const now = isSquareAttackedByColor(
                            afterBoard,
                            sq,
                            moverColor,
                        );
                        const movedAttacks = pieceAttacksSquare(
                            afterBoard,
                            movedTo,
                            { type: movedPieceType, color: moverColor },
                            sq,
                        );
                        if (!was && now && !movedAttacks) {
                            tags.add('discoveredAttack');
                            break;
                        }
                    }
                }
            }
        }

        // Mate/back-rank mate detection from PV itself.
        if (isCheckmatePosition(chess)) {
            tags.add('mate');

            // mateInN based on PV ply index (only meaningful if solver delivers mate).
            if (i % 2 === 0) {
                const mateIn = Math.trunc(i / 2) + 1;
                if (mateIn > 0 && mateIn <= 5) tags.add(`mateIn${mateIn}`);
                else tags.add('mateInN');
            }

            // backRankMate (approx): checkmated king is on back rank with pawns trapping it,
            // and the mating piece is a rook/queen delivering a straight-line check.
            const victim = chess.turn() as PieceColor; // side to move is checkmated
            const victimKing = findKingSquare(chess.board(), victim);
            if (victimKing) {
                const kxy = squareToXY(victimKing);
                if (kxy) {
                    const backRank = victim === 'w' ? 0 : 7; // y coordinate: rank1 for white, rank8 for black
                    if (kxy.y === backRank) {
                        const pawnRank = victim === 'w' ? 1 : 6;
                        let pawnBlockers = 0;
                        for (const fx of [kxy.x - 1, kxy.x, kxy.x + 1]) {
                            if (fx < 0 || fx > 7) continue;
                            const p = pieceAt(chess.board(), fx, pawnRank);
                            if (p && p.color === victim && p.type === 'p')
                                pawnBlockers++;
                        }
                        const matingPiece =
                            (mv.piece as PieceType | undefined) ?? undefined;
                        const matingTo = mv.to ?? undefined;
                        let rookLikeGivesCheck = false;
                        if (
                            (matingPiece === 'r' || matingPiece === 'q') &&
                            matingTo
                        ) {
                            rookLikeGivesCheck = pieceAttacksSquare(
                                chess.board(),
                                matingTo,
                                {
                                    type: matingPiece,
                                    color: otherColor(victim),
                                },
                                victimKing,
                            );
                        }
                        if (pawnBlockers >= 2 && rookLikeGivesCheck)
                            tags.add('backRankMate');
                    }
                }
            }

            break;
        }
    }

    // Deflection / attraction (approximate, very conservative):
    // - attraction: opponent king captures the checking/sacrificed piece immediately.
    // - deflection: check-sac and (forced) capture followed by another check.
    if (pv.length >= 2) {
        const c0 = new Chess(args.startFen);
        const m1 = parseUci(pv[0] ?? '');
        const m2 = parseUci(pv[1] ?? '');
        if (m1 && m2) {
            const mv1 = c0.move({
                from: m1.from,
                to: m1.to,
                promotion: m1.promotion,
            }) as MoveExt | null;
            if (mv1) {
                const gaveCheck = c0.inCheck();
                const oppKingSq = findKingSquare(
                    c0.board(),
                    c0.turn() as PieceColor,
                );
                if (gaveCheck && oppKingSq) {
                    // attraction: king takes the checking piece on the next move
                    if (m2.from === oppKingSq && m2.to === mv1.to)
                        tags.add('attraction');
                }
            }
        }
    }
    if (pv.length >= 3) {
        const c0 = new Chess(args.startFen);
        const m1 = parseUci(pv[0] ?? '');
        const m2 = parseUci(pv[1] ?? '');
        const m3 = parseUci(pv[2] ?? '');
        if (m1 && m2 && m3) {
            const mv1 = c0.move({
                from: m1.from,
                to: m1.to,
                promotion: m1.promotion,
            }) as MoveExt | null;
            const gaveCheck = !!mv1 && c0.inCheck();
            const mv2 = c0.move({
                from: m2.from,
                to: m2.to,
                promotion: m2.promotion,
            }) as MoveExt | null;
            const capturedAttacker =
                !!mv2 && !!mv1 && mv2.to === mv1.to && !!mv2.captured;
            const mv3 = c0.move({
                from: m3.from,
                to: m3.to,
                promotion: m3.promotion,
            }) as MoveExt | null;
            const nextCheck = !!mv3 && c0.inCheck();
            if (gaveCheck && capturedAttacker && nextCheck)
                tags.add('deflection');
        }
    }

    return Array.from(tags).sort();
}

function severityFromSwing(swingCp: number): MistakeSeverity {
    if (swingCp >= 400) return 'big';
    if (swingCp >= 200) return 'medium';
    return 'small';
}

function tagsForCandidate(args: {
    fenBefore: string;
    fenAfter: string;
    moverColor: 'w' | 'b';
    bestAtBefore: EvalResult;
    bestAtAfter: EvalResult;
    swingCp: number;
}): { tags: string[]; severity: MistakeSeverity } {
    const tags = new Set<string>();

    // Motif tags from the training FEN + best line PV (deterministic, no
    // extra engine calls).
    for (const t of motifTagsFromPv({
        startFen: args.fenBefore,
        pvUci: args.bestAtBefore.pvUci,
        score: args.bestAtBefore.score,
    })) {
        tags.add(t);
    }

    // Heuristic tag 1: mate threat
    if (args.bestAtBefore.score?.type === 'mate') {
        const m = args.bestAtBefore.score.value;
        if (m > 0 && Math.abs(m) <= 5) tags.add('mateThreat');
    }

    // Heuristic tag 2: consequence of the actually played mistake. Punish
    // candidates pass the same start FEN twice, so inspecting their solution PV
    // here would incorrectly label intentional sacrifices as hanging pieces.
    if (args.fenBefore !== args.fenAfter) {
        const baseMat = materialByColorFromFen(args.fenAfter);
        const afterLine = applyUciPlies({
            fen: args.fenAfter,
            uciLine: args.bestAtAfter.pvUci ?? [],
            maxPlies: 4,
        });
        if (afterLine.pliesApplied >= 1) {
            const mat2 = materialByColorFromFen(afterLine.fen);
            const moverKey = args.moverColor === 'w' ? 'w' : 'b';
            const loss = baseMat[moverKey] - mat2[moverKey];
            if (loss >= 3) tags.add('hangingPiece');
        }
    }

    const severity = severityFromSwing(args.swingCp);
    return { tags: Array.from(tags).sort(), severity };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved options and helpers
// ─────────────────────────────────────────────────────────────────────────────

type ResolvedOptions = {
    movetimeMs: number;
    nodesPerPosition: number | null;
    maxDepth: number | null;
    engineTimeoutMs: number;
    minWinningChanceLoss: number;
    fallbackMinCpLoss: number;
    gradingPolicy: GradingPolicyV3;
    themeLookaheadPlies: number;
    confirmMovetimeMs: number | null;
    confirmNodes: number | null;
    maxConfirmationNodes: number | null;
    returnAnalysis: boolean;
    multiPv: number;
    maxMultiPv: number;
    maxAcceptedMoves: number;
    verifyContinuations: boolean;
    verificationMaxPlies: number;
    verificationMaxPositions: number;
    verificationNodesPerPosition: number | null;
    verificationMaxDepth: number | null;
};

export function resolveTrainingMomentExtractionOptions(
    options?: TrainingMomentExtractionOptions,
): ResolvedOptions {
    const confirmNodes =
        options?.confirmNodes === null
            ? null
            : Math.max(1, Math.trunc(options?.confirmNodes ?? 200_000));
    const maxConfirmationNodes =
        confirmNodes == null || options?.maxConfirmationNodes === null
            ? null
            : Math.max(
                  confirmNodes,
                  Math.min(
                      20_000_000,
                      Math.trunc(
                          options?.maxConfirmationNodes ?? confirmNodes * 4,
                      ),
                  ),
              );
    const multiPv = Math.max(
        1,
        Math.min(16, Math.trunc(options?.multiPv ?? 5)),
    );
    const maxMultiPv = Math.max(
        multiPv,
        Math.min(16, Math.trunc(options?.maxMultiPv ?? 16)),
    );
    return {
        movetimeMs: Math.max(1, Math.trunc(options?.movetimeMs ?? 200)),
        nodesPerPosition:
            options?.nodesPerPosition === null
                ? null
                : Math.max(1, Math.trunc(options?.nodesPerPosition ?? 100_000)),
        maxDepth:
            options?.maxDepth == null
                ? null
                : Math.max(1, Math.trunc(options.maxDepth)),
        engineTimeoutMs: Math.max(
            1_000,
            Math.trunc(options?.engineTimeoutMs ?? 30_000),
        ),
        minWinningChanceLoss: Math.max(
            0,
            Math.min(1, options?.minWinningChanceLoss ?? 0.03),
        ),
        fallbackMinCpLoss: Math.max(0, options?.fallbackMinCpLoss ?? 30),
        gradingPolicy: normalizeGradingPolicy(options?.gradingPolicy),
        themeLookaheadPlies: options?.themeLookaheadPlies ?? 4,
        confirmMovetimeMs: options?.confirmMovetimeMs ?? null,
        confirmNodes,
        maxConfirmationNodes,
        returnAnalysis: options?.returnAnalysis ?? false,
        multiPv,
        maxMultiPv,
        maxAcceptedMoves: Math.max(
            1,
            Math.min(16, Math.trunc(options?.maxAcceptedMoves ?? maxMultiPv)),
        ),
        verifyContinuations: options?.verifyContinuations ?? true,
        verificationMaxPlies: Math.max(
            1,
            Math.min(32, options?.verificationMaxPlies ?? 2),
        ),
        verificationMaxPositions: Math.max(
            1,
            Math.min(128, options?.verificationMaxPositions ?? 32),
        ),
        verificationNodesPerPosition:
            options?.verificationNodesPerPosition === null
                ? null
                : Math.max(
                      1,
                      options?.verificationNodesPerPosition ??
                          options?.nodesPerPosition ??
                          100_000,
                  ),
        verificationMaxDepth:
            options?.verificationMaxDepth == null
                ? null
                : Math.max(1, options.verificationMaxDepth),
    };
}

/**
 * Convert UCI to SAN using chess.js
 */
function uciToSan(fen: string, uci: string): string | null {
    const parsed = parseUci(uci);
    if (!parsed) return null;
    try {
        const c = new Chess(fen);
        const move = c.move({
            from: parsed.from,
            to: parsed.to,
            promotion: parsed.promotion,
        });
        return move?.san ?? null;
    } catch {
        return null;
    }
}

function hasUsablePv(evaluation: EvalResult): boolean {
    // One legal PV move is enough: mate-in-one and quiet single-decision
    // moments are both complete training roots.
    return (evaluation.pvUci?.length ?? 0) >= 1;
}

function analysisLimit(
    opts: ResolvedOptions,
    confirmation = false,
    signal?: AbortSignal,
): {
    nodes?: number;
    depth?: number;
    movetimeMs?: number;
    timeoutMs: number;
    signal?: AbortSignal;
} {
    const nodes = confirmation
        ? (opts.confirmNodes ?? opts.nodesPerPosition ?? undefined)
        : (opts.nodesPerPosition ?? undefined);
    const depth =
        nodes == null && opts.maxDepth != null ? opts.maxDepth : undefined;
    const movetimeMs =
        nodes == null && depth == null
            ? confirmation && opts.confirmMovetimeMs != null
                ? opts.confirmMovetimeMs
                : opts.movetimeMs
            : undefined;
    return {
        ...(nodes != null ? { nodes } : {}),
        ...(depth != null ? { depth } : {}),
        ...(movetimeMs != null ? { movetimeMs } : {}),
        timeoutMs: opts.engineTimeoutMs,
        ...(signal ? { signal } : {}),
    };
}

function evalFromMultiPv(
    fen: string,
    result: MultiPvResult,
): EvalResult | null {
    const line =
        result.lines.find((candidate) => candidate.multipv === 1) ??
        result.lines[0];
    if (!line) return null;
    return {
        fen,
        bestMoveUci: result.bestMoveUci || line.pvUci[0] || '',
        pvUci: line.pvUci,
        score: line.score,
        wdl: line.wdl,
        depth: line.depth,
        selDepth: line.selDepth,
        nodes: line.nodes,
        nps: line.nps,
        timeMs: line.timeMs,
        searchEvidence: result.searchEvidence,
    };
}

function repetitionPositionKey(fen: string): string | null {
    try {
        return new Chess(fen).fen().split(/\s+/).slice(0, 4).join(' ');
    } catch {
        return null;
    }
}

function completesThreefoldRepetition(
    previousFens: string[],
    rootFen: string,
    afterFen: string,
): boolean {
    const afterKey = repetitionPositionKey(afterFen);
    if (!afterKey) return false;
    let occurrences = 0;
    for (const fen of [...previousFens.slice(-256), rootFen, afterFen]) {
        if (repetitionPositionKey(fen) === afterKey) {
            occurrences += 1;
        }
    }
    return occurrences >= 3;
}

type RepetitionDrawMove = {
    moveUci: string;
    afterFen: string;
};

function repetitionCompletingMoves(
    previousFens: string[],
    rootFen: string,
): RepetitionDrawMove[] {
    let chess: Chess;
    try {
        chess = new Chess(rootFen);
    } catch {
        return [];
    }
    const moves = chess.moves({ verbose: true }).slice(0, 256);
    const result: RepetitionDrawMove[] = [];
    for (const move of moves) {
        const moveUci = `${move.from}${move.to}${move.promotion ?? ''}`;
        const after = new Chess(rootFen);
        const played = after.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion,
        });
        if (
            played &&
            completesThreefoldRepetition(previousFens, rootFen, after.fen())
        ) {
            result.push({ moveUci, afterFen: after.fen() });
        }
    }
    return result;
}

function ruleDrawOutranksEvaluation(
    evaluation: Pick<EvalResult, 'bestMoveUci' | 'score' | 'wdl'>,
    repetitionMoves: RepetitionDrawMove[],
): boolean {
    if (
        repetitionMoves.some(
            (move) => move.moveUci === normalizeUci(evaluation.bestMoveUci),
        )
    ) {
        return true;
    }
    const chance = winningChance(evaluation.score, evaluation.wdl);
    if (chance != null) return chance < 0.5;
    const cp = scoreToOrderingCp(evaluation.score);
    return cp != null && cp < 0;
}

function promoteRepetitionDrawEvaluation(args: {
    evaluation: EvalResult;
    fen: string;
    previousFens: string[];
}): EvalResult {
    const repetitionMoves = repetitionCompletingMoves(
        args.previousFens,
        args.fen,
    );
    if (
        repetitionMoves.length === 0 ||
        !ruleDrawOutranksEvaluation(args.evaluation, repetitionMoves)
    ) {
        return args.evaluation;
    }
    const best = repetitionMoves[0]!;
    return {
        ...ruleDrawEvaluation(args.fen),
        bestMoveUci: best.moveUci,
        pvUci: [best.moveUci],
    };
}

function mergeRepetitionDrawMultiPv(args: {
    result: MultiPvResult;
    fen: string;
    previousFens: string[];
}): MultiPvResult {
    const repetitionMoves = repetitionCompletingMoves(
        args.previousFens,
        args.fen,
    );
    if (repetitionMoves.length === 0) return args.result;
    const engineEvaluation = evalFromMultiPv(args.fen, args.result);
    if (!engineEvaluation) return args.result;
    const ruleIsBest = ruleDrawOutranksEvaluation(
        engineEvaluation,
        repetitionMoves,
    );
    const repetitionMoveSet = new Set(
        repetitionMoves.map((move) => move.moveUci),
    );
    const engineLines = args.result.lines.filter(
        (line) => !repetitionMoveSet.has(normalizeUci(line.pvUci[0] ?? '')),
    );
    const ruleLines: MultiPvLine[] = repetitionMoves.map((move, index) => ({
        multipv: index + 1,
        pvUci: [move.moveUci],
        score: { type: 'cp', value: 0 },
        wdl: { win: 0, draw: 1_000, loss: 0 },
    }));
    const ordered = ruleIsBest
        ? [...ruleLines, ...engineLines]
        : [...engineLines, ...ruleLines];
    return {
        ...args.result,
        bestMoveUci: ordered[0]?.pvUci[0] ?? args.result.bestMoveUci,
        lines: ordered.map((line, index) => ({
            ...line,
            multipv: index + 1,
        })),
    };
}

function ruleDrawEvaluation(fen: string): EvalResult {
    return {
        fen,
        bestMoveUci: '',
        pvUci: [],
        score: { type: 'cp', value: 0 },
        wdl: { win: 0, draw: 1_000, loss: 0 },
    };
}

/**
 * Re-check the event's before/after loss and the solution alternatives at the
 * confirmation budget. A changed but equivalent best move is not a rejection.
 */
type ConfirmationCandidateResult = {
    confirmed: boolean;
    newEval?: EvalResult;
    beforeEval?: EvalResult;
    afterEval?: EvalResult;
    loss?: ReturnType<typeof evaluationLoss>;
    multiPvResult?: MultiPvResult;
    confirmedLossCp?: number;
    confirmedWinningChanceLoss?: number;
    originalMetrics?: TrainingMoveMetrics;
};

async function confirmCandidate(args: {
    engine: StockfishEngine;
    beforeFen: string;
    afterFen: string;
    solutionFen: string;
    minimumWinningChanceLoss: number;
    fallbackMinimumLossCp: number;
    gradingPolicy: GradingPolicyV3;
    multiPv: number;
    limit: ReturnType<typeof analysisLimit>;
    previousFens?: string[];
}): Promise<ConfirmationCandidateResult> {
    const rootChess = new Chess(args.solutionFen);
    const original = rootChess
        .moves({ verbose: true })
        .find((move) => move.after === args.afterFen);
    if (!original || args.beforeFen !== args.solutionFen)
        return { confirmed: false };
    const moveUci = `${original.from}${original.to}${original.promotion ?? ''}`;
    const multiPvResult = mergeRepetitionDrawMultiPv({
        result: await args.engine.analyzeMultiPv({
            fen: args.solutionFen,
            multiPv: args.multiPv,
            ...args.limit,
            previousFens: args.previousFens,
            reuse: 'FRESH_REQUIRED',
            purpose: 'MISTAKE_REFERENCE',
        }),
        fen: args.solutionFen,
        previousFens: args.previousFens ?? [],
    });
    const solutionEval = evalFromMultiPv(args.solutionFen, multiPvResult);
    if (!solutionEval || !hasUsablePv(solutionEval))
        return { confirmed: false, multiPvResult };
    let playedRoot = await args.engine.evalPosition({
        fen: args.solutionFen,
        ...args.limit,
        rootMoves: [moveUci],
        previousFens: args.previousFens,
        reuse: 'FRESH_REQUIRED',
        purpose: 'MISTAKE_ORIGINAL',
    });
    if (
        claimableDraw(args.afterFen, [
            ...(args.previousFens ?? []),
            args.beforeFen,
        ]) &&
        (winningChance(playedRoot.score, playedRoot.wdl) ?? 0) < 0.5
    )
        playedRoot = {
            ...playedRoot,
            score: { type: 'cp', value: 0 },
            wdl: { win: 0, draw: 1000, loss: 0 },
        };
    if (!playedRoot.score || !playedRoot.pvUci.length)
        return { confirmed: false, multiPvResult };
    const terminal = ruleTerminalEvaluation(args.afterFen);
    const afterEval: EvalResult = terminal ?? {
        ...playedRoot,
        fen: args.afterFen,
        score: negateScore(playedRoot.score),
        wdl: reverseWdl(playedRoot.wdl),
    };
    const loss = evaluationLoss(
        { score: solutionEval.score, wdl: solutionEval.wdl },
        { score: playedRoot.score, wdl: playedRoot.wdl },
    );
    const confirmed =
        (loss.winningChance != null &&
            loss.winningChance >= args.minimumWinningChanceLoss) ||
        (loss.cp != null && loss.cp >= args.fallbackMinimumLossCp) ||
        (solutionEval.score?.type === 'mate' &&
            playedRoot.score.type !== 'mate');
    const side = sideToMoveFromFen(args.solutionFen);
    const originalMetrics = metricsFromMatchedOutcomeEvidence({
        moveUci,
        originalMoveUci: moveUci,
        trainingSide: side,
        bestScore: engineScoreToWhitePov(solutionEval.score, side),
        submittedScore: engineScoreToWhitePov(afterEval.score, otherSide(side)),
        originalScore: engineScoreToWhitePov(afterEval.score, otherSide(side)),
        bestWdlChance: engineWdlChance(solutionEval.wdl, side, side),
        submittedWdlChance: engineWdlChance(
            afterEval.wdl,
            otherSide(side),
            side,
        ),
        stable: true,
    });
    return {
        confirmed,
        originalMetrics,
        newEval: solutionEval,
        beforeEval: solutionEval,
        afterEval,
        loss,
        multiPvResult,
        confirmedLossCp: loss.cp ?? undefined,
        confirmedWinningChanceLoss: loss.winningChance ?? undefined,
    };
}

function confirmationBudgets(baseNodes: number, maxNodes: number): number[] {
    const budgets = [Math.max(1, Math.trunc(baseNodes))];
    const cap = Math.max(budgets[0]!, Math.trunc(maxNodes));
    while (budgets.at(-1)! < cap) {
        const current = budgets.at(-1)!;
        budgets.push(Math.min(cap, current * 2));
    }
    return budgets;
}

function nearCoverageThreshold(
    loss: ReturnType<typeof evaluationLoss>,
    args: {
        minimumWinningChanceLoss: number;
        fallbackMinimumLossCp: number;
    },
): boolean {
    if (loss.winningChance != null) {
        const margin = Math.max(0.01, args.minimumWinningChanceLoss * 0.5);
        return (
            Math.abs(loss.winningChance - args.minimumWinningChanceLoss) <=
            margin
        );
    }
    if (loss.cp != null) {
        const margin = Math.max(20, args.fallbackMinimumLossCp * 0.25);
        return Math.abs(loss.cp - args.fallbackMinimumLossCp) <= margin;
    }
    return true;
}

function confirmationLossesDisagree(
    previous: ReturnType<typeof evaluationLoss>,
    current: ReturnType<typeof evaluationLoss>,
): boolean {
    if (previous.winningChance != null && current.winningChance != null) {
        return Math.abs(previous.winningChance - current.winningChance) > 0.015;
    }
    if (previous.cp != null && current.cp != null) {
        return Math.abs(previous.cp - current.cp) > 40;
    }
    return true;
}

async function confirmCandidateAdaptively(args: {
    engine: StockfishEngine;
    beforeFen: string;
    afterFen: string;
    solutionFen: string;
    minimumWinningChanceLoss: number;
    fallbackMinimumLossCp: number;
    gradingPolicy: GradingPolicyV3;
    multiPv: number;
    baseNodes: number;
    maxNodes: number;
    timeoutMs: number;
    previousFens?: string[];
    initialBestMoveUci: string;
    initialLoss: ReturnType<typeof evaluationLoss>;
    initialMetrics: TrainingMoveMetrics;
    signal?: AbortSignal;
}): Promise<
    ConfirmationCandidateResult & {
        confirmationEvidence: AdaptiveConfirmationEvidence;
    }
> {
    const budgets = confirmationBudgets(args.baseNodes, args.maxNodes);
    let previousLoss = args.initialLoss;
    let previousQualifies = true;
    let previousGrade = gradeTrainingMove(
        args.initialMetrics,
        args.gradingPolicy,
    );
    let previousModel = args.initialMetrics.evidenceModel;

    let latest: ConfirmationCandidateResult = { confirmed: false };
    const passes: AdaptiveConfirmationEvidence['passes'] = [];

    for (const [index, nodes] of budgets.entries()) {
        latest = await confirmCandidate({
            engine: args.engine,
            beforeFen: args.beforeFen,
            afterFen: args.afterFen,
            solutionFen: args.solutionFen,
            minimumWinningChanceLoss: args.minimumWinningChanceLoss,
            fallbackMinimumLossCp: args.fallbackMinimumLossCp,
            multiPv: args.multiPv,
            gradingPolicy: args.gradingPolicy,
            limit: { nodes, timeoutMs: args.timeoutMs, signal: args.signal },
            previousFens: args.previousFens,
        });
        const complete = Boolean(
            latest.newEval &&
            latest.beforeEval &&
            latest.afterEval &&
            latest.loss,
        );
        const currentBestMove = normalizeUci(latest.newEval?.bestMoveUci ?? '');
        passes.push({
            nodes,
            bestMoveUci: currentBestMove || null,
            qualifies: latest.confirmed,
            cpLoss: latest.loss?.cp ?? null,
            winChanceLoss: latest.loss?.winningChance ?? null,
        });

        const currentGrade = latest.originalMetrics
            ? gradeTrainingMove(latest.originalMetrics, args.gradingPolicy)
            : null;
        const originalConclusionChanged =
            currentGrade?.status !== 'GRADED' ||
            previousGrade.status !== 'GRADED' ||
            currentGrade.accepted !== previousGrade.accepted;
        const modelChanged =
            latest.originalMetrics?.evidenceModel !== previousModel;
        const disagreement =
            originalConclusionChanged ||
            modelChanged ||
            !complete ||
            previousQualifies !== latest.confirmed ||
            (latest.loss != null &&
                nearCoverageThreshold(latest.loss, args) &&
                confirmationLossesDisagree(previousLoss, latest.loss));
        const nearThreshold = latest.originalMetrics
            ? (latest.originalMetrics.bestGapCp != null &&
                  Math.abs(
                      latest.originalMetrics.bestGapCp -
                          args.gradingPolicy.success.maxCpLoss,
                  ) <= 20) ||
              (latest.originalMetrics.bestGapWinChance != null &&
                  Math.abs(
                      latest.originalMetrics.bestGapWinChance -
                          args.gradingPolicy.success.maxWinChanceLoss,
                  ) <= 0.02)
            : true;
        const isLast = index === budgets.length - 1;
        const needsMore = !isLast && (disagreement || nearThreshold);

        if (needsMore) {
            if (latest.loss) previousLoss = latest.loss;
            if (currentGrade) previousGrade = currentGrade;
            previousModel = latest.originalMetrics?.evidenceModel;
            previousQualifies = latest.confirmed;

            continue;
        }

        const stable = complete && !disagreement;
        const termination: AdaptiveConfirmationEvidence['termination'] =
            !complete
                ? 'INCOMPLETE'
                : !stable
                  ? 'MAX_BUDGET_UNSTABLE'
                  : latest.confirmed
                    ? 'STABLE'
                    : 'BELOW_THRESHOLD';
        return {
            ...latest,
            confirmed: latest.confirmed && stable,
            confirmationEvidence: {
                version: 1,
                stable,
                termination,
                passes,
            },
        };
    }

    return {
        ...latest,
        confirmed: false,
        confirmationEvidence: {
            version: 1,
            stable: false,
            termination: 'INCOMPLETE',
            passes,
        },
    };
}

function normalizeUci(uci: string): string {
    return (uci ?? '').trim().toLowerCase();
}

function decisionReceipt(args: {
    ply: number;
    reason: TrainingDecisionReceipt['reason'];
    loss?: ReturnType<typeof evaluationLoss> | null;
    confirmation?: AdaptiveConfirmationEvidence;
}): TrainingDecisionReceipt {
    const status: TrainingDecisionReceipt['status'] =
        args.reason === 'MISTAKE_CONFIRMED'
            ? 'SAVED'
            : args.reason === 'ENGINE_EVIDENCE_INVALID' ||
                args.reason === 'MISTAKE_COMPARISON_UNRESOLVED'
              ? 'UNRESOLVED'
              : 'NOT_SAVED';
    return {
        ply: args.ply,
        status,
        reason: args.reason,
        cpLoss: args.loss?.cp ?? null,
        winChanceLoss: args.loss?.winningChance ?? null,
        ...(args.confirmation ? { confirmation: args.confirmation } : {}),
    };
}

export function canonicalDecisionKey(
    moment: Pick<
        TrainingMomentCandidate,
        'sourceGameId' | 'sourcePgnHash' | 'decisionPly' | 'fen'
    >,
): string {
    return [
        moment.sourceGameId,
        moment.sourcePgnHash,
        String(moment.decisionPly),
        moment.fen,
    ].join('::');
}

function stableCanonicalStringify(value: unknown): string {
    const canonicalize = (input: unknown): unknown => {
        if (input == null) return input;
        if (Array.isArray(input)) return input.map(canonicalize);
        if (typeof input === 'number') {
            return Number.isFinite(input) ? input : null;
        }
        if (typeof input !== 'object') return input;
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(
            input as Record<string, unknown>,
        ).sort()) {
            const item = (input as Record<string, unknown>)[key];
            if (item !== undefined) output[key] = canonicalize(item);
        }
        return output;
    };
    return JSON.stringify(canonicalize(value));
}

async function sourcePgnHash(pgn: string): Promise<string> {
    const normalized = pgn.replace(/\r\n?/g, '\n').trim();
    return sha256Hex(`backranq-source-pgn\u0000${normalized}`);
}

function otherSide(side: 'w' | 'b'): 'w' | 'b' {
    return side === 'w' ? 'b' : 'w';
}

function engineScoreToWhitePov(
    score: Score | null,
    scorePov: 'w' | 'b',
): PovScore | null {
    if (!score) return null;
    if (score.type === 'cp') {
        return {
            kind: 'cp',
            cp: scorePov === 'w' ? score.value : -score.value,
            pov: 'WHITE',
        };
    }
    const winner = score.value > 0 ? scorePov : otherSide(scorePov);
    const distance = Math.abs(Math.trunc(score.value));
    return {
        kind: 'mate',
        // UCI mate N is a move count. Convert it to a conservative exact ply
        // distance based on whether the score owner or the opponent mates.
        plies: score.value > 0 ? distance * 2 - 1 : distance * 2,
        winner: winner === 'w' ? 'WHITE' : 'BLACK',
    };
}

function tablebaseScoreToWhitePov(
    wdl: 'WIN' | 'DRAW' | 'LOSS' | 'UNKNOWN',
    mover: 'w' | 'b',
    dtz?: number,
): PovScore | null {
    if (wdl === 'UNKNOWN') return null;
    const whiteWdl =
        mover === 'w'
            ? wdl
            : wdl === 'WIN'
              ? 'LOSS'
              : wdl === 'LOSS'
                ? 'WIN'
                : 'DRAW';
    return {
        kind: 'tablebase',
        wdl: whiteWdl,
        pov: 'WHITE',
        ...(dtz != null ? { dtz } : {}),
    };
}

function verifiedEvaluationToWhitePov(
    evaluation: VerifiedMoveEvaluation,
    mover: 'w' | 'b',
): PovScore | null {
    if (evaluation.source === 'ENGINE') {
        return engineScoreToWhitePov(evaluation.score, mover);
    }
    if (evaluation.source === 'TABLEBASE') {
        return tablebaseScoreToWhitePov(evaluation.wdl, mover, evaluation.dtz);
    }
    return {
        kind: 'tablebase',
        wdl: 'DRAW',
        pov: 'WHITE',
    };
}

async function solutionHash(
    input: Omit<
        SolutionRevisionInput,
        'solutionHash' | 'evidence' | 'generatorVersion' | 'configHash'
    >,
): Promise<string> {
    return sha256Hex(
        stableTrainingStringify(canonicalSolutionSemantics(input)),
    );
}

const SOURCE_KIND_ORDER: readonly TrainingSourceKind[] = [
    'MY_MISTAKE',
    'MISSED_OPPORTUNITY',
];
const LESSON_KIND_ORDER: readonly TrainingLessonKind[] = [
    'AVOID_MISTAKE',
    'PUNISH_MISTAKE',
    'SAVE_DRAW',
    'PRESERVE_WIN',
    'CONVERT_ADVANTAGE',
    'IMPROVE_POSITION',
];

function orderedMetadataUnion<T extends string>(
    left: readonly T[],
    right: readonly T[],
    order: readonly T[],
): T[] {
    const values = new Set([...left, ...right]);
    return order.filter((value) => values.has(value));
}

/**
 * Avoid and punish evidence for one user decision is merged into one canonical
 * moment. Neither detection mode participates in identity.
 */
function storeCanonicalTrainingMoment(
    moments: TrainingMomentCandidate[],
    candidate: TrainingMomentCandidate,
) {
    const key = canonicalDecisionKey(candidate);
    const index = moments.findIndex(
        (existing) => canonicalDecisionKey(existing) === key,
    );
    if (index < 0) {
        moments.push(candidate);
        return;
    }
    const existing = moments[index]!;
    const rank = { VERIFIED: 3, AMBIGUOUS: 2, UNSTABLE: 1, INVALID: 0 };
    const candidateRank = rank[candidate.solution.verificationStatus];
    const existingRank = rank[existing.solution.verificationStatus];
    const candidateHasDirectMistakeEvidence =
        candidate.sourceKinds.includes('MY_MISTAKE');
    const existingHasDirectMistakeEvidence =
        existing.sourceKinds.includes('MY_MISTAKE');
    const preferred =
        candidateRank > existingRank ||
        (candidateRank === existingRank &&
            candidateHasDirectMistakeEvidence &&
            !existingHasDirectMistakeEvidence)
            ? candidate
            : existing;
    moments[index] = {
        ...preferred,
        sourceKinds: orderedMetadataUnion(
            existing.sourceKinds,
            candidate.sourceKinds,
            SOURCE_KIND_ORDER,
        ),
        lessonKinds: orderedMetadataUnion(
            existing.lessonKinds,
            candidate.lessonKinds,
            LESSON_KIND_ORDER,
        ),
        themes: Array.from(
            new Set([...existing.themes, ...candidate.themes]),
        ).sort(),
    };
}

async function buildTrainingMoment(args: {
    game: NormalizedGame;
    canonicalSourceGameId: string;
    sourcePgnHash: string;
    decisionPly: number;
    fen: string;
    originalMoveUci: string;
    originalScoreBefore: PovScore;
    originalScoreAfter: PovScore;
    originalLoss: ReturnType<typeof evaluationLoss>;
    originalMetrics: TrainingMoveMetrics;
    practicalLessonEvidence?: unknown;
    sourceKind: TrainingSourceKind;
    lessonKind: TrainingLessonKind;
    themes: string[];
    solutionEval: EvalResult;
    acceptedMovesUci: string[];
    evaluatedLines: MultiPvLine[];
    acceptanceFrontier?: AcceptanceFrontier;
    engine: StockfishEngine;
    tablebase?: TablebaseProvider;
    opts: ResolvedOptions;
    configHash: string;
    previousFens: string[];
    verificationCache: Map<string, Promise<ContinuationVerificationResult>>;
    signal?: AbortSignal;
}): Promise<TrainingMomentCandidate> {
    // Exact evidence may replace an engine reference only as a complete pair.
    // UNKNOWN original outcomes leave the confirmed engine core intact.
    let exactPair: Awaited<ReturnType<TablebaseProvider['probe']>> | null =
        null;
    if (args.tablebase && nonKingPieceCountFromFen(args.fen) <= 5) {
        try {
            const exact = await args.tablebase.probe(args.fen, {
                signal: args.signal,
            });
            const original = exact?.moves.find(
                (move) =>
                    move.uci === args.originalMoveUci && move.wdl !== 'UNKNOWN',
            );
            if (
                exact &&
                exact.wdl !== 'UNKNOWN' &&
                original &&
                exact.moves.some((move) => move.wdl === exact.wdl)
            ) {
                const side = sideToMoveFromFen(args.fen);
                const before = tablebaseScoreToWhitePov(exact.wdl, side)!;
                const after = tablebaseScoreToWhitePov(original.wdl, side)!;
                args = {
                    ...args,
                    originalScoreBefore: before,
                    originalScoreAfter: after,
                    originalLoss: {
                        cp: null,
                        winningChance: Math.max(
                            0,
                            (exact.wdl === 'WIN'
                                ? 1
                                : exact.wdl === 'DRAW'
                                  ? 0.5
                                  : 0) -
                                (original.wdl === 'WIN'
                                    ? 1
                                    : original.wdl === 'DRAW'
                                      ? 0.5
                                      : 0),
                        ),
                    },
                    originalMetrics: metricsFromMatchedOutcomeEvidence({
                        moveUci: args.originalMoveUci,
                        originalMoveUci: args.originalMoveUci,
                        trainingSide: side,
                        bestScore: before,
                        submittedScore: after,
                        originalScore: after,
                        stable: true,
                    }),
                };
                exactPair = exact;
            }
        } catch (error) {
            if (args.signal?.aborted) throw error;
        }
    }
    const key = `${args.sourcePgnHash}:${args.decisionPly}:${args.fen}`;
    let pending = args.verificationCache.get(key);
    if (!pending) {
        pending = verifyConditionalContinuation({
            fen: args.fen,
            engine: args.engine,
            tablebase: exactPair
                ? {
                      probe: async (fen, options) =>
                          fen === args.fen
                              ? exactPair
                              : args.tablebase!.probe(fen, options),
                  }
                : args.tablebase,
            options: {
                maxPlies: args.opts.verifyContinuations
                    ? args.opts.verificationMaxPlies
                    : 1,
                maxPositions: args.opts.verificationMaxPositions,
                multiPv: args.opts.multiPv,
                maxMultiPv: args.opts.maxMultiPv,
                maxUserBranches: args.opts.maxAcceptedMoves,
                gradingPolicy: args.opts.gradingPolicy,
                nodesPerPosition: args.opts.verificationNodesPerPosition,
                maxDepth: args.opts.verificationMaxDepth,
                movetimeMs: args.opts.movetimeMs,
                timeoutMs: args.opts.engineTimeoutMs,
                signal: args.signal,
                previousFens: args.previousFens,
                seed: exactPair
                    ? undefined
                    : {
                          fen: args.fen,
                          bestMoveUci: args.solutionEval.bestMoveUci,
                          lines: args.evaluatedLines,
                          searchEvidence: args.solutionEval.searchEvidence,
                      },
            },
        });
        args.verificationCache.set(key, pending);
    }
    const verification = await pending;
    const root = verification.root;
    const side = sideToMoveFromFen(args.fen);
    const referenceId = verification.answerCoverage.referenceId;
    const bestMoveUci =
        root.acceptedMovesUci[0] ?? args.solutionEval.bestMoveUci;
    const bestEvaluation = root.moveEvaluations?.find(
        (move) => move.moveUci === bestMoveUci,
    )?.evaluation;
    const scoreAtStart = bestEvaluation
        ? verifiedEvaluationToWhitePov(bestEvaluation, side)
        : engineScoreToWhitePov(args.solutionEval.score, side);

    const moveAssessments: SolutionMoveAssessmentInput[] = [];
    const collectAssessments = (node: VerifiedSolutionNode) => {
        if (node.role === 'USER') {
            const nodeSide = sideToMoveFromFen(node.fen);
            const preferred = node.moveEvaluations?.find(
                (item) => item.moveUci === node.acceptedMovesUci[0],
            )?.evaluation;
            const referenceScore = preferred
                ? verifiedEvaluationToWhitePov(preferred, nodeSide)
                : null;
            const referenceChance =
                preferred?.source === 'ENGINE'
                    ? engineWdlChance(preferred.wdl, nodeSide, side)
                    : null;
            for (const item of node.moveEvaluations ?? []) {
                // The explicit matched original pass is authoritative at the root.
                if (node === root && item.moveUci === args.originalMoveUci)
                    continue;
                const scoreAfter = verifiedEvaluationToWhitePov(
                    item.evaluation,
                    nodeSide,
                );
                const metrics = metricsFromMatchedOutcomeEvidence({
                    moveUci: item.moveUci,
                    originalMoveUci: args.originalMoveUci,
                    trainingSide: side,
                    bestScore: referenceScore,
                    submittedScore: scoreAfter,
                    originalScore: args.originalScoreAfter,
                    bestWdlChance: referenceChance,
                    submittedWdlChance:
                        item.evaluation.source === 'ENGINE'
                            ? engineWdlChance(
                                  item.evaluation.wdl,
                                  nodeSide,
                                  side,
                              )
                            : null,
                    stable: true,
                });
                const grade = gradeTrainingMove(
                    metrics,
                    args.opts.gradingPolicy,
                );
                if (grade.status !== 'GRADED') continue;
                moveAssessments.push({
                    positionKey: node.contextId,
                    decisionIndex: Math.floor(node.ply / 2),
                    fen: node.fen,
                    moveUci: item.moveUci,
                    source:
                        item.evaluation.source === 'TABLEBASE'
                            ? 'TABLEBASE'
                            : 'PRECOMPUTED',
                    grade: grade.grade,
                    referenceId: node.referenceId ?? referenceId,
                    tierStable: item.tierStable,
                    scoreAfter,
                    evidence: { ...metrics, evaluation: item.evaluation },
                });
            }
        }
        for (const branch of node.branches) collectAssessments(branch.child);
    };
    collectAssessments(root);
    const originalGrade = gradeTrainingMove(
        args.originalMetrics,
        args.opts.gradingPolicy,
    );
    if (originalGrade.status === 'GRADED')
        moveAssessments.push({
            positionKey: root.contextId,
            decisionIndex: 0,
            fen: args.fen,
            moveUci: args.originalMoveUci,
            source: 'PRECOMPUTED',
            grade: originalGrade.grade,
            referenceId,
            tierStable: true,
            scoreAfter: args.originalScoreAfter,
            evidence: {
                ...args.originalMetrics,
                comparisonSource: 'PAIRED_ROOT_ORIGINAL',
            },
        });
    const acceptedMovesUci = root.acceptedMovesUci.filter((move) =>
        moveAssessments.some(
            (item) =>
                item.moveUci === move &&
                ['BEST', 'STRONG', 'GOOD'].includes(item.grade),
        ),
    );
    const originalAccepted = moveAssessments.some(
        (item) =>
            item.moveUci === args.originalMoveUci &&
            ['BEST', 'STRONG', 'GOOD'].includes(item.grade),
    );
    const trainable =
        verification.status === 'VERIFIED' &&
        acceptedMovesUci.length > 0 &&
        !originalAccepted;
    const frontier: AcceptanceFrontier = {
        ...(root.acceptanceFrontier ?? {
            version: 1,
            status: 'OPEN',
            targetCutoffCp: args.opts.gradingPolicy.success.maxCpLoss,
            effectiveCutoffCp: null,
            boundaryGapCp: null,
            firstRejectedMoveUci: null,
            moves: [],
        }),
        status: acceptedMovesUci.length ? 'STABLE' : 'OPEN',
        moves: acceptedMovesUci.map((moveUci) => ({
            moveUci,
            tier: moveAssessments.find((item) => item.moveUci === moveUci)!
                .grade as 'BEST' | 'STRONG' | 'GOOD',
        })),
    };
    const assessedMovesUci = moveAssessments
        .filter(
            (item) =>
                item.positionKey === root.contextId && item.decisionIndex === 0,
        )
        .map((item) => item.moveUci)
        .sort();
    const answerCoverage = {
        ...verification.answerCoverage,
        assessedMovesUci,
        status: verification.answerCoverage.legalMovesUci.every((move) =>
            assessedMovesUci.includes(move),
        )
            ? ('ALL_LEGAL_ASSESSED' as const)
            : ('PARTIAL' as const),
    };
    root.answerCoverage = answerCoverage;
    root.acceptanceFrontier = frontier;
    root.acceptedMovesUci = acceptedMovesUci;
    root.alternativesComplete = answerCoverage.status === 'ALL_LEGAL_ASSESSED';
    root.branches = root.branches.filter((branch) =>
        acceptedMovesUci.includes(branch.moveUci),
    );
    const decision = {
        status: originalAccepted
            ? ('NOT_A_MISTAKE' as const)
            : trainable
              ? ('CONFIRMED_MISTAKE' as const)
              : ('UNRESOLVED' as const),
        reason: originalAccepted
            ? 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
            : trainable
              ? 'MISTAKE_CONFIRMED'
              : 'MISTAKE_COMPARISON_UNRESOLVED',
    };
    const solutionCore: Omit<
        SolutionRevisionInput,
        'solutionHash' | 'evidence' | 'generatorVersion' | 'configHash'
    > = {
        decision,
        answerCoverage,
        continuation: verification.continuation,
        verificationStatus: verification.status,
        solutionShape:
            acceptedMovesUci.length > 1
                ? 'MULTIPLE'
                : acceptedMovesUci.length === 1
                  ? 'UNIQUE'
                  : 'OPEN',
        gradingStrategy:
            root.evidenceSource === 'TABLEBASE' ? 'TABLEBASE' : 'PRECOMPUTED',
        continuationShape:
            verification.bestLineUci.length > 1
                ? 'CONDITIONAL_LINE'
                : 'SINGLE_DECISION',
        trainable,
        bestMoveUci,
        acceptedMovesUci,
        acceptanceFrontier: frontier,
        moveAssessments,
        bestLineUci: verification.bestLineUci,
        solutionTree: root,
        scoreAtStart,
        playedMoveScore: args.originalScoreAfter,
        targetOutcome: { kind: 'MAXIMIZE_WINNING_CHANCE', score: scoreAtStart },
        gradingPolicy: args.opts.gradingPolicy,
    };
    // The canonical solution tree already carries every verified node and its
    // move evidence. Reference it from verifier metadata instead of serializing
    // the same history-heavy tree twice in each API payload.
    const { root: verifiedRoot, ...verifierMetadata } = verification;
    const solution: SolutionRevisionInput = {
        ...solutionCore,
        solutionHash: await solutionHash(solutionCore),
        evidence: {
            verifier: {
                ...verifierMetadata,
                rootContextId: verifiedRoot.contextId,
            },
            extraction: {
                originalLoss: args.originalLoss,
                practicalLesson: args.practicalLessonEvidence ?? null,
                rootEvaluation: args.solutionEval,
            },
        },
        generatorVersion: 'backranq-training-extractor-v4',
        configHash: args.configHash,
    };
    return {
        sourceGameId: args.canonicalSourceGameId,
        sourceProvider: args.game.provider,
        sourcePlayedAt: args.game.playedAt,
        sourcePgnHash: args.sourcePgnHash,
        decisionPly: args.decisionPly,
        fen: args.fen,
        positionHistory: args.previousFens,
        sideToMove: side,
        originalMoveUci: args.originalMoveUci,
        sourceKinds: [args.sourceKind],
        lessonKinds: [args.lessonKind],
        themes: [...new Set(args.themes)].sort(),
        originalDecision: {
            scoreBefore: args.originalScoreBefore,
            scoreAfter: args.originalScoreAfter,
            ...(args.originalLoss.cp != null
                ? { cpLoss: args.originalLoss.cp }
                : {}),
            ...(args.originalLoss.winningChance != null
                ? { winChanceLoss: args.originalLoss.winningChance }
                : {}),
        },
        phase: phaseFromPosition({
            fen: args.fen,
            ply: args.decisionPly,
        }).toUpperCase() as 'OPENING' | 'MIDDLEGAME' | 'ENDGAME',
        solution,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main extraction function
// ─────────────────────────────────────────────────────────────────────────────

export async function extractTrainingMomentsFromGames(args: {
    games: NormalizedGame[];
    selectedGameIds: Set<string>;
    engine: StockfishEngine;
    tablebase?: TablebaseProvider;
    /**
     * Maps UI/provider game ids to the canonical database source id used by
     * persistence. Defaults to the input game id for offline/test consumers.
     */
    canonicalSourceGameIdByGameId?:
        ReadonlyMap<string, string> | Readonly<Record<string, string>>;
    /**
     * The enclosing immutable analysis-run config hash. Server callers should
     * supply it; standalone callers receive a deterministic extractor hash.
     */
    analysisConfigHash?: string;
    onProgress?: (p: {
        gameId: string;
        gameIndex: number;
        gameCount: number;
        ply: number;
        plyCount: number;
        phase?: string;
    }) => void;
    options?: TrainingMomentExtractionOptions;
    /** Cancels browser/server engine work and prevents stale onboarding runs. */
    signal?: AbortSignal;
    /** Previously persisted state for a resumable single-game server slice. */
    checkpoint?: TrainingMomentExtractionCheckpoint;
    /**
     * Checked only between fully processed plies. Returning true yields a
     * checkpoint without marking the extraction complete.
     */
    shouldYield?: () => boolean;
    /**
     * Landing-only fast path. Returns immediately after the first fully VERIFIED
     * candidate is built. Canonical full-game extraction leaves this disabled.
     */
    stopAfterFirstVerified?: boolean;
    /** Partial landing search; never produces full-game completion evidence. */
    landingSearch?: LandingSearch;
}): Promise<TrainingMomentExtractionResult> {
    if (args.signal?.aborted) throw new Error('Analysis aborted');
    const selected = args.games.filter((game) =>
        args.selectedGameIds.has(game.id),
    );
    if (
        (args.checkpoint || args.shouldYield || args.landingSearch) &&
        selected.length !== 1
    )
        throw new Error(
            'Landing/resumable extraction requires one non-resumable partial game or one checkpoint game',
        );
    if (
        args.landingSearch &&
        (!args.stopAfterFirstVerified || args.checkpoint || args.shouldYield)
    )
        throw new Error(
            'Landing search requires one non-resumable partial game',
        );
    const opts = resolveTrainingMomentExtractionOptions(args.options);
    const identity =
        (await args.engine.getIdentity?.().catch(() => null)) ?? null;
    const configSnapshot = createExtractionConfigSnapshot({
        engine: identity,
        extractor: opts,
    });
    const configHash =
        args.analysisConfigHash ??
        (await sha256Hex(stableCanonicalStringify(configSnapshot)));
    const moments: TrainingMomentCandidate[] = [
        ...(args.checkpoint?.moments ?? []),
    ];
    const manifests: ExtractionCompletionManifest[] = [];
    const analysisMap = new Map<string, GameAnalysis>();
    const verificationCache = new Map<
        string,
        Promise<ContinuationVerificationResult>
    >();
    for (const [gameIndex, game] of selected.entries()) {
        const sourceId = canonicalSourceGameId(
            args.canonicalSourceGameIdByGameId,
            game.id,
        );
        const pgnHash = await sourcePgnHash(game.pgn);
        const scope =
            args.landingSearch?.mode === 'SCOUT'
                ? 'SCOUT'
                : args.landingSearch || args.stopAfterFirstVerified
                  ? 'TARGETED_DECISION'
                  : 'FULL_GAME';
        const manifest = (
            termination: ExtractionCompletionManifest['termination'],
            moves: number,
            scanned: number,
            errors: string[],
            outcomes: ExtractionCompletionManifest['decisionOutcomes'],
        ): ExtractionCompletionManifest => ({
            version: 1,
            scope,
            sourceGameId: sourceId,
            sourcePgnHash: pgnHash,
            scannedPlies: scanned,
            expectedPlies: moves,
            termination,
            errors,
            scanComplete: scanned === moves,
            extractionComplete:
                scanned === moves &&
                termination === 'COMPLETED' &&
                scope === 'FULL_GAME',
            complete:
                scanned === moves &&
                termination === 'COMPLETED' &&
                scope === 'FULL_GAME',
            decisionOutcomes: outcomes,
        });
        let moves: Move[];
        try {
            const chess = new Chess();
            chess.loadPgn(game.pgn, { strict: false });
            moves = chess.history({ verbose: true }) as Move[];
        } catch {
            manifests.push(
                manifest(
                    'INVALID_SOURCE',
                    0,
                    0,
                    ['Source PGN could not be parsed'],
                    [],
                ),
            );
            continue;
        }
        const userColor = userColorForGame(game);
        if (!userColor) {
            manifests.push(
                manifest(
                    'USER_SIDE_UNRESOLVED',
                    moves.length,
                    0,
                    ['Training side could not be resolved'],
                    [],
                ),
            );
            continue;
        }
        const resume = args.checkpoint;
        if (
            resume &&
            (resume.gameId !== game.id ||
                resume.configHash !== configHash ||
                resume.sourcePgnHash !== pgnHash ||
                resume.sourceGameId !== sourceId)
        )
            throw new Error(
                'Analysis checkpoint does not match source or extraction',
            );
        const startPly = resume?.nextPly ?? 0;
        const gameAnalysis: AnalyzedMove[] = [...(resume?.gameAnalysis ?? [])];
        const whiteMoveAccuracies = [...(resume?.whiteMoveAccuracies ?? [])];
        const blackMoveAccuracies = [...(resume?.blackMoveAccuracies ?? [])];
        const errors = [...(resume?.extractionErrors ?? [])];
        const receipts = new Map<number, TrainingDecisionReceipt>(
            resume?.decisionReceipts ?? [],
        );
        const scanCache = new Map<string, Promise<EvalResult>>();
        let previousLoss: EvaluationLoss | undefined = resume?.previousMoveLoss;
        let scanned = startPly;
        const cacheKey = (fen: string, history: string[]) =>
            stableCanonicalStringify({
                fen,
                history,
                limit: analysisLimit(opts, false, args.signal),
            });
        for (const item of resume?.scanEvidence ?? [])
            scanCache.set(
                cacheKey(item.fen, item.previousFens),
                Promise.resolve(item.evaluation),
            );
        const scanRecords: Array<{
            fen: string;
            previousFens: string[];
            evaluation: EvalResult;
        }> = [];
        const scan = async (
            fen: string,
            history: string[],
        ): Promise<EvalResult> => {
            const key = cacheKey(fen, history);
            let pending = scanCache.get(key);
            if (!pending) {
                pending = (async () => {
                    const terminal = ruleTerminalEvaluation(fen, history);
                    const evaluated =
                        terminal ??
                        (await args.engine.evalPosition({
                            fen,
                            ...analysisLimit(opts, false, args.signal),
                            previousFens: history,
                            reuse: 'REUSE_ALLOWED',
                            purpose: 'GAME_SCAN',
                        }));
                    if (args.signal?.aborted)
                        throw new Error('Analysis aborted');
                    const promoted = terminal
                        ? evaluated
                        : promoteRepetitionDrawEvaluation({
                              evaluation: evaluated,
                              fen,
                              previousFens: history,
                          });
                    scanRecords.push({
                        fen,
                        previousFens: history,
                        evaluation: promoted,
                    });
                    if (scanRecords.length > 2) scanRecords.shift();
                    return promoted;
                })();
                scanCache.set(key, pending);
            }
            return pending;
        };
        const checkpoint = (
            nextPly: number,
            pendingScan = false,
            pendingConfirmation?: TrainingMomentExtractionCheckpoint['pendingConfirmation'],
            pendingOpponentError?: boolean,
        ): TrainingMomentExtractionResult => ({
            moments,
            manifests: [],
            configSnapshot,
            configHash,
            analysis: opts.returnAnalysis ? analysisMap : undefined,
            checkpoint: {
                version: 1,
                gameId: game.id,
                sourceGameId: sourceId,
                sourcePgnHash: pgnHash,
                configHash,
                nextPly,
                expectedPlies: moves.length,
                moments,
                gameAnalysis,
                whiteMoveAccuracies,
                blackMoveAccuracies,
                extractionErrors: errors,
                decisionReceipts: [...receipts],
                previousMoveLoss: previousLoss,
                scanEvidence: scanRecords.length
                    ? scanRecords
                    : (resume?.scanEvidence ?? []),
                pendingScan,
                pendingConfirmation,
                pendingOpponentError,
            },
        });
        for (let ply = startPly; ply < moves.length; ply++) {
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            if (ply > startPly && args.shouldYield?.()) return checkpoint(ply);
            const move = moves[ply]!;
            const fen = move.before,
                afterFen = move.after;
            const previousFens = moves
                .slice(Math.max(0, ply - MAX_ASSESSMENT_POSITION_HISTORY), ply)
                .map((item) => item.before);
            const side = sideToMoveFromFen(fen);
            const originalMoveUci = `${move.from}${move.to}${move.promotion ?? ''}`;
            const isUser = side === userColor;
            const hasDecision = new Chess(fen).moves().length > 1;
            if (ruleTerminalEvaluation(fen, previousFens)) {
                if (isUser)
                    receipts.set(
                        ply,
                        decisionReceipt({ ply, reason: 'SOURCE_INVALID' }),
                    );
                errors.push(
                    `Ply ${ply}: source continues after a mandatory rule ending`,
                );
                scanned = ply;
                break;
            }
            args.onProgress?.({
                gameId: game.id,
                gameIndex,
                gameCount: selected.length,
                ply,
                plyCount: moves.length,
                phase: 'scanning',
            });
            let best: EvalResult, after: EvalResult;
            try {
                best = await scan(fen, previousFens);
                after = await scan(
                    afterFen,
                    appendAssessmentHistory(previousFens, fen),
                );
            } catch (error) {
                if (args.signal?.aborted) throw error;
                if (isUser)
                    receipts.set(
                        ply,
                        decisionReceipt({
                            ply,
                            reason: 'ENGINE_EVIDENCE_INVALID',
                        }),
                    );
                errors.push(
                    `Ply ${ply}: ${error instanceof Error ? error.message : 'Engine evidence unavailable'}`,
                );
                scanned = ply + 1;
                previousLoss = undefined;
                continue;
            }
            if (
                args.shouldYield?.() &&
                !(resume?.pendingScan && ply === startPly)
            )
                return checkpoint(ply, true);
            if (
                !best.score ||
                !after.score ||
                (!best.terminal && !hasUsablePv(best))
            ) {
                if (isUser)
                    receipts.set(
                        ply,
                        decisionReceipt({
                            ply,
                            reason: 'ENGINE_EVIDENCE_INVALID',
                        }),
                    );
                errors.push(`Ply ${ply}: missing exact engine evidence`);
                scanned = ply + 1;
                continue;
            }
            const loss = evaluationLoss(
                { score: best.score, wdl: best.wdl },
                { score: negateScore(after.score), wdl: reverseWdl(after.wdl) },
            );
            const beforeCp = scoreToCp(best.score),
                afterCp = scoreToCp(after.score);
            const swing =
                beforeCp == null || afterCp == null
                    ? 0
                    : Math.max(0, beforeCp + afterCp);
            if (
                opts.returnAnalysis &&
                !(resume?.pendingConfirmation && ply === startPly)
            ) {
                const accuracy =
                    hasDecision && beforeCp != null && afterCp != null
                        ? lichessMoveAccuracyFromCps({
                              beforeCp,
                              afterCp: -afterCp,
                          }).accuracy
                        : undefined;
                if (accuracy != null)
                    (side === 'w'
                        ? whiteMoveAccuracies
                        : blackMoveAccuracies
                    ).push(accuracy);
                gameAnalysis.push({
                    ply,
                    san: move.san,
                    uci: originalMoveUci,
                    classification: classifyMove({
                        cpLoss: swing,
                        isBestMove: originalMoveUci === best.bestMoveUci,
                        wasAlreadyLost: (beforeCp ?? 0) < -300,
                    }),
                    evalBefore: best.score,
                    evalAfter: after.score,
                    cpLoss: swing,
                    accuracy,
                    bestMoveUci: best.bestMoveUci,
                    bestMoveSan: uciToSan(fen, best.bestMoveUci) ?? undefined,
                });
            }
            const opponentError =
                resume?.pendingConfirmation && ply === startPly
                    ? resume.pendingOpponentError === true
                    : previousLoss != null &&
                      ((previousLoss.winningChance ?? 0) >=
                          opts.minWinningChanceLoss ||
                          (previousLoss.cp ?? 0) >= opts.fallbackMinCpLoss);
            previousLoss = loss;
            scanned = ply + 1;
            if (!isUser) continue;
            if (!hasDecision) {
                receipts.set(
                    ply,
                    decisionReceipt({ ply, reason: 'FORCED_MOVE', loss }),
                );
                continue;
            }
            const candidate =
                (loss.winningChance ?? 0) >= opts.minWinningChanceLoss ||
                (loss.cp ?? 0) >= opts.fallbackMinCpLoss ||
                (best.score?.type === 'mate' &&
                    best.score.value > 0 &&
                    after.score?.type !== 'mate');
            if (!candidate) {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'BELOW_CANDIDATE_SIGNAL',
                        loss,
                    }),
                );
                continue;
            }
            if (args.landingSearch?.mode === 'SCOUT') {
                args.landingSearch.onCandidate({ decisionPly: ply, loss });
                continue;
            }
            if (
                args.landingSearch?.mode === 'VERIFY' &&
                args.landingSearch.decisionPly !== ply
            )
                continue;
            if (!hasUsablePv(best) || !after.score) {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'ENGINE_EVIDENCE_INVALID',
                        loss,
                    }),
                );
                continue;
            }
            args.onProgress?.({
                gameId: game.id,
                gameIndex,
                gameCount: selected.length,
                ply,
                plyCount: moves.length,
                phase: 'confirming',
            });
            let confirmed: ConfirmationCandidateResult & {
                confirmationEvidence?: AdaptiveConfirmationEvidence;
            };
            try {
                confirmed =
                    resume?.pendingConfirmation && ply === startPly
                        ? resume.pendingConfirmation
                        : opts.confirmNodes != null &&
                            opts.maxConfirmationNodes != null
                          ? await confirmCandidateAdaptively({
                                engine: args.engine,
                                beforeFen: fen,
                                afterFen,
                                solutionFen: fen,
                                minimumWinningChanceLoss:
                                    opts.minWinningChanceLoss,
                                fallbackMinimumLossCp: opts.fallbackMinCpLoss,
                                gradingPolicy: opts.gradingPolicy,
                                multiPv: opts.multiPv,
                                baseNodes: opts.confirmNodes,
                                maxNodes: opts.maxConfirmationNodes,
                                timeoutMs: opts.engineTimeoutMs,
                                previousFens,
                                initialBestMoveUci: best.bestMoveUci,
                                initialLoss: loss,
                                initialMetrics:
                                    metricsFromMatchedOutcomeEvidence({
                                        moveUci: originalMoveUci,
                                        originalMoveUci,
                                        trainingSide: side,
                                        bestScore: engineScoreToWhitePov(
                                            best.score,
                                            side,
                                        ),
                                        submittedScore: engineScoreToWhitePov(
                                            after.score,
                                            otherSide(side),
                                        ),
                                        originalScore: engineScoreToWhitePov(
                                            after.score,
                                            otherSide(side),
                                        ),
                                        bestWdlChance: engineWdlChance(
                                            best.wdl,
                                            side,
                                            side,
                                        ),
                                        submittedWdlChance: engineWdlChance(
                                            after.wdl,
                                            otherSide(side),
                                            side,
                                        ),
                                        stable: true,
                                    }),
                                signal: args.signal,
                            })
                          : await confirmCandidate({
                                engine: args.engine,
                                beforeFen: fen,
                                afterFen,
                                solutionFen: fen,
                                minimumWinningChanceLoss:
                                    opts.minWinningChanceLoss,
                                fallbackMinimumLossCp: opts.fallbackMinCpLoss,
                                gradingPolicy: opts.gradingPolicy,
                                multiPv: opts.multiPv,
                                limit: analysisLimit(opts, true, args.signal),
                                previousFens,
                            });
            } catch (error) {
                if (args.signal?.aborted) throw error;
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'ENGINE_EVIDENCE_INVALID',
                        loss,
                    }),
                );
                continue;
            }
            if (
                args.shouldYield?.() &&
                !(resume?.pendingConfirmation && ply === startPly)
            )
                return checkpoint(ply, true, confirmed, opponentError);
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            const finalBest = confirmed.newEval;
            const finalAfter = confirmed.afterEval;
            const finalLoss = confirmed.loss ?? loss;
            if (!confirmed.confirmed || !finalBest || !finalAfter) {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason:
                            confirmed.confirmationEvidence?.termination ===
                            'BELOW_THRESHOLD'
                                ? 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
                                : 'MISTAKE_COMPARISON_UNRESOLVED',
                        loss: finalLoss,
                        confirmation: confirmed.confirmationEvidence,
                    }),
                );
                continue;
            }
            const bestScore = engineScoreToWhitePov(finalBest.score, side);
            const playedScore = engineScoreToWhitePov(
                finalAfter.score,
                otherSide(side),
            );
            if (!bestScore || !playedScore) {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'ENGINE_EVIDENCE_INVALID',
                        loss: finalLoss,
                    }),
                );
                continue;
            }
            const originalMetrics = metricsFromMatchedOutcomeEvidence({
                moveUci: originalMoveUci,
                originalMoveUci,
                trainingSide: side,
                bestScore,
                submittedScore: playedScore,
                originalScore: playedScore,
                bestWdlChance: engineWdlChance(finalBest.wdl, side, side),
                submittedWdlChance: engineWdlChance(
                    finalAfter.wdl,
                    otherSide(side),
                    side,
                ),
                stable: true,
            });
            const originalGrade = gradeTrainingMove(
                originalMetrics,
                opts.gradingPolicy,
            );
            if (originalGrade.status !== 'GRADED') {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'MISTAKE_COMPARISON_UNRESOLVED',
                        loss: finalLoss,
                        confirmation: confirmed.confirmationEvidence,
                    }),
                );
                continue;
            }
            if (originalGrade.accepted) {
                receipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: 'ORIGINAL_MOVE_QUALITY_CONFIRMED',
                        loss: finalLoss,
                        confirmation: confirmed.confirmationEvidence,
                    }),
                );
                continue;
            }
            const chance = winningChance(finalBest.score, finalBest.wdl);
            const saturated =
                finalBest.score?.type === 'cp' &&
                finalAfter.score?.type === 'cp' &&
                finalBest.wdl &&
                finalAfter.wdl &&
                chance != null &&
                (chance >= 0.98 || chance <= 0.02) &&
                (finalLoss.winningChance ?? 0) < opts.minWinningChanceLoss;
            let practicalLessonEvidence: unknown;
            if (saturated) {
                // Concrete material consequence in the confirmed pair, not heuristic motif tags.
                const material = (position: string) => {
                    const m = materialByColorFromFen(position);
                    return side === 'w' ? m.w - m.b : m.b - m.w;
                };
                const bestEnd = applyUciPlies({
                    fen,
                    uciLine: finalBest.pvUci,
                    maxPlies: 6,
                });
                const playedEnd = applyUciPlies({
                    fen,
                    uciLine: finalAfter.pvUci,
                    maxPlies: 6,
                });
                if (
                    !bestEnd ||
                    !playedEnd ||
                    material(bestEnd.fen) - material(playedEnd.fen) < 1.5
                ) {
                    receipts.set(
                        ply,
                        decisionReceipt({
                            ply,
                            reason: 'NO_SUPPORTED_PRACTICAL_LESSON',
                            loss: finalLoss,
                            confirmation: confirmed.confirmationEvidence,
                        }),
                    );
                    continue;
                }
                practicalLessonEvidence = {
                    kind: 'BOUNDED_PV_MATERIAL_CONSEQUENCE',
                    maxPlies: 6,
                    materialDifferencePawns:
                        material(bestEnd.fen) - material(playedEnd.fen),
                    best: {
                        pvUci: finalBest.pvUci.slice(0, 6),
                        resultFen: bestEnd.fen,
                        searchEvidence: finalBest.searchEvidence,
                    },
                    original: {
                        pvUci: finalAfter.pvUci.slice(0, 6),
                        resultFen: playedEnd.fen,
                        searchEvidence: finalAfter.searchEvidence,
                    },
                    certainty: 'EMPIRICAL_ENGINE_LINE',
                };
            }
            const evaluatedLines = confirmed.multiPvResult?.lines ?? [];
            const frontier = acceptanceFrontierFromMultiPv({
                lines: evaluatedLines,
                requestedMultiPv: opts.multiPv,
                alternativesComplete:
                    confirmed.multiPvResult?.alternativesComplete,
                policy: opts.gradingPolicy,
            });
            const built = await buildTrainingMoment({
                game,
                canonicalSourceGameId: sourceId,
                sourcePgnHash: pgnHash,
                decisionPly: ply,
                fen,
                originalMoveUci,
                originalScoreBefore: bestScore,
                originalScoreAfter: playedScore,
                originalLoss: finalLoss,
                originalMetrics,
                practicalLessonEvidence,
                sourceKind: 'MY_MISTAKE',
                lessonKind:
                    beforeCp != null &&
                    Math.abs(beforeCp) <= 100 &&
                    (afterCp ?? 0) > 100
                        ? 'SAVE_DRAW'
                        : 'AVOID_MISTAKE',
                themes: tagsForCandidate({
                    fenBefore: fen,
                    fenAfter: afterFen,
                    moverColor: side,
                    bestAtBefore: finalBest,
                    bestAtAfter: finalAfter,
                    swingCp: finalLoss.cp ?? 0,
                }).tags,
                solutionEval: finalBest,
                acceptedMovesUci: frontier.moves.map((item) => item.moveUci),
                evaluatedLines,
                acceptanceFrontier: frontier,
                engine: args.engine,
                tablebase: args.tablebase,
                opts,
                configHash,
                previousFens,
                verificationCache,
                signal: args.signal,
            });
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            if (opponentError) {
                built.sourceKinds = ['MY_MISTAKE', 'MISSED_OPPORTUNITY'];
                built.lessonKinds = [
                    ...new Set([
                        ...built.lessonKinds,
                        'PUNISH_MISTAKE' as const,
                    ]),
                ];
            }
            if (built.solution.trainable)
                storeCanonicalTrainingMoment(moments, built);
            receipts.set(ply, {
                ...decisionReceipt({
                    ply,
                    reason: built.solution.decision
                        .reason as TrainingDecisionReceipt['reason'],
                    loss: finalLoss,
                    confirmation: confirmed.confirmationEvidence,
                }),
                verificationStatus: built.solution.verificationStatus,
                sourceKinds: built.sourceKinds,
            });
            if (
                args.stopAfterFirstVerified &&
                isLandingReadyTrainingMoment(built)
            )
                return {
                    moments: [built],
                    manifests: [],
                    configSnapshot,
                    configHash,
                    analysis: opts.returnAnalysis ? analysisMap : undefined,
                };
        }
        if (scope !== 'FULL_GAME') continue;
        const decisions = [...receipts.values()].sort((a, b) => a.ply - b.ply);
        const outcomes = decisions.map((item) => ({
            decisionPly: item.ply,
            status:
                item.status === 'SAVED'
                    ? ('CONFIRMED_MISTAKE' as const)
                    : item.reason === 'FORCED_MOVE' ||
                        item.reason === 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
                      ? ('NOT_A_MISTAKE' as const)
                      : ('UNRESOLVED' as const),
            reason: item.reason,
        }));
        manifests.push(
            manifest(
                scanned === moves.length
                    ? 'COMPLETED'
                    : 'SOURCE_REPLAY_STOPPED',
                moves.length,
                scanned,
                errors,
                outcomes,
            ),
        );
        if (opts.returnAnalysis) {
            const reasonCounts = emptyExtractionReasonCounts();
            for (const item of decisions) reasonCounts[item.reason]++;
            for (const analyzed of gameAnalysis) {
                const moment = moments.find(
                    (m) =>
                        m.sourceGameId === sourceId &&
                        m.decisionPly === analyzed.ply &&
                        m.solution.trainable,
                );
                if (moment) {
                    analyzed.hasTrainingMoment = true;
                    analyzed.trainingMomentSource = moment.sourceKinds.includes(
                        'MISSED_OPPORTUNITY',
                    )
                        ? 'MISSED_OPPORTUNITY'
                        : 'MY_MISTAKE';
                }
            }
            analysisMap.set(game.id, {
                gameId: game.id,
                moves: gameAnalysis,
                whiteAccuracy:
                    lichessGameAccuracy({
                        moveAccuracies: whiteMoveAccuracies,
                    }) ?? undefined,
                blackAccuracy:
                    lichessGameAccuracy({
                        moveAccuracies: blackMoveAccuracies,
                    }) ?? undefined,
                analyzedAt: new Date().toISOString(),
                trainingExtraction: {
                    version: 1,
                    trainingSide: userColor === 'w' ? 'WHITE' : 'BLACK',
                    thresholds: {
                        minWinChanceLoss: opts.minWinningChanceLoss,
                        fallbackMinCpLoss: opts.fallbackMinCpLoss,
                    },
                    budgets: {
                        scanNodes: opts.nodesPerPosition,
                        confirmationBaseNodes: opts.confirmNodes,
                        confirmationMaxNodes: opts.maxConfirmationNodes,
                        multiPvStart: opts.multiPv,
                        multiPvMax: opts.maxMultiPv,
                    },
                    summary: {
                        userDecisions: decisions.length,
                        savedPositions: decisions.filter(
                            (item) => item.status === 'SAVED',
                        ).length,
                        unresolvedDecisions: decisions.filter(
                            (item) => item.status === 'UNRESOLVED',
                        ).length,
                        reasons: reasonCounts,
                    },
                    decisions,
                },
            });
        }
    }
    return {
        moments,
        manifests,
        configSnapshot,
        configHash,
        analysis: opts.returnAnalysis ? analysisMap : undefined,
    };
}
