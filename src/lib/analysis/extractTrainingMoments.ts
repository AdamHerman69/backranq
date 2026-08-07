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
    evaluationLoss,
    isWithinEvaluationLoss,
    negateScore,
    qualifiesEvaluationLoss,
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
import { solutionSemanticsHash } from '@/lib/training/contracts';
import { normalizeGradingPolicy } from '@/lib/training/config';
import { acceptanceFrontierFromMultiPv } from '@/lib/training/acceptanceFrontier';
import {
    appendAssessmentHistory,
    assessmentPositionKey,
} from '@/lib/training/assessmentIdentity';
import { metricsFromPovScores } from '@/lib/training/gradingEvidence';
import {
    emptyExtractionReasonCounts,
    type AdaptiveConfirmationEvidence,
    type TrainingDecisionReceipt,
    type TrainingExtractionReceipt,
} from '@/lib/analysis/extractionReceipt';

type MistakeSeverity = 'small' | 'medium' | 'big';

const PRESERVE_WIN_MIN_LOSS_CP = 150;
const PRESERVE_WIN_MIN_POSITION_CP = 200;
const BIG_MISTAKE_CLASSIFICATION_CP = 250;
const DRAWISH_POSITION_ABS_CP = 100;
const CLEARLY_WORSE_POSITION_CP = -100;

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
    /** Primary ALL_CONFIRMED eligibility threshold. */
    minWinningChanceLoss?: number; // default 0.03
    /** Used only if winning chance cannot be computed. */
    fallbackMinCpLoss?: number; // default 30
    /** Versioned grading tolerance persisted with each solution. */
    gradingPolicy?: GradingPolicyV3;
    /** How many plies into the PV to look for tactical moves. Defaults to 4. */
    themeLookaheadPlies?: number;

    /**
     * Re-evaluate candidate moments at higher depth to confirm they hold up.
     * If set, candidates are re-checked at this movetime; if the swing shrinks
     * below threshold or best move changes, the moment is discarded.
     * A deterministic 200k-node confirmation is used by default.
     */
    confirmMovetimeMs?: number | null;
    /**
     * Preferred deterministic budget for confirmation. Set null to disable
     * the second pass explicitly.
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
    maxAcceptedWinningChanceLoss?: number; // default 0.05
    fallbackMaxAcceptedCpLoss?: number; // default 50

    /** Bounded conditional verification is enabled by default. */
    verifyContinuations?: boolean;
    /**
     * One user decision plus the opponent's best reply. Additional engine PV
     * moves remain available in review, but never create another grading gate.
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
    moment: TrainingMomentCandidate
): boolean {
    return (
        moment.solution.trainable &&
        moment.solution.verificationStatus === 'VERIFIED' &&
        moment.solution.acceptanceFrontier.status === 'STABLE' &&
        moment.solution.acceptedMovesUci.length > 0 &&
        moment.solution.bestLineUci.length > 0
    );
}

/**
 * Authoritative training-moment extraction result.
 */
export type TrainingMomentExtractionResult = {
    moments: TrainingMomentCandidate[];
    manifests: ExtractionCompletionManifest[];
    configSnapshot: Record<string, unknown>;
    configHash: string;
    /**
     * Move-by-move analysis for each game, keyed by game ID.
     * Only populated if options.returnAnalysis is true.
     */
    analysis?: Map<string, GameAnalysis>;
};

export type ExtractionCompletionManifest = {
    version: 1;
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
    gameId: string
): string {
    if (!mapping) return gameId;
    if (typeof (mapping as ReadonlyMap<string, string>).get === 'function') {
        return (
            (mapping as ReadonlyMap<string, string>).get(gameId) ?? gameId
        );
    }
    return (mapping as Readonly<Record<string, string>>)[gameId] ?? gameId;
}

function scoreToCp(score: Score | null): number | null {
    return scoreToOrderingCp(score);
}

function parseUci(
    uci: string
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
    uciMove: string
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

/**
 * Check if PV contains at least one tactical move within the first N plies.
 */
function pvContainsTactic(
    startFen: string,
    pvUci: string[],
    lookaheadPlies: number
): boolean {
    const chess = new Chess(startFen);
    const plies = Math.min(pvUci.length, lookaheadPlies);

    for (let i = 0; i < plies; i++) {
        const uci = pvUci[i];
        if (!uci) break;

        const { isCheck, isCapture, isPromotion } = tacticalMoveFacts(
            chess,
            uci
        );
        if (isCheck || isCapture || isPromotion) return true;

        // Apply move to advance position for next iteration
        const parsed = parseUci(uci);
        if (!parsed) break;
        try {
            chess.move({
                from: parsed.from,
                to: parsed.to,
                promotion: parsed.promotion,
            });
        } catch {
            break;
        }
    }

    return false;
}

function extractStartFenFromPgn(pgn: string): string | null {
    // If PGN has a setup position, prefer it over trying to undo moves.
    const m = pgn.match(/^\[FEN\s+"([^"]+)"\]\s*$/m);
    return m?.[1] ?? null;
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

function perspectiveCp(
    evalCpFromSideToMove: number,
    moverColor: 'w' | 'b',
    sideToMove: 'w' | 'b'
) {
    return moverColor === sideToMove
        ? evalCpFromSideToMove
        : -evalCpFromSideToMove;
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
    ty: number
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
    target: string
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
    attackerColor: PieceColor
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
                    target
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
    dy: number
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
                                sq
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
                            { dx: -1, dy: -1 }
                        );
                    }
                    if (movedPieceType === 'r' || movedPieceType === 'q') {
                        dirs.push(
                            { dx: 1, dy: 0 },
                            { dx: -1, dy: 0 },
                            { dx: 0, dy: 1 },
                            { dx: 0, dy: -1 }
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
                                d.dy
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
                        moverColor
                    );
                    const movedGivesCheck = pieceAttacksSquare(
                        afterBoard,
                        movedTo,
                        { type: movedPieceType, color: moverColor },
                        enemyKingAfter
                    );
                    if (!wasAttackedBefore && !movedGivesCheck) {
                        const attackedAfter = isSquareAttackedByColor(
                            afterBoard,
                            enemyKingAfter,
                            moverColor
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
                            moverColor
                        );
                        const now = isSquareAttackedByColor(
                            afterBoard,
                            sq,
                            moverColor
                        );
                        const movedAttacks = pieceAttacksSquare(
                            afterBoard,
                            movedTo,
                            { type: movedPieceType, color: moverColor },
                            sq
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
                                victimKing
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
                    c0.turn() as PieceColor
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
    maxAcceptedWinningChanceLoss: number;
    fallbackMaxAcceptedCpLoss: number;
    verifyContinuations: boolean;
    verificationMaxPlies: number;
    verificationMaxPositions: number;
    verificationNodesPerPosition: number | null;
    verificationMaxDepth: number | null;
};

function resolveOptions(
    options?: TrainingMomentExtractionOptions
): ResolvedOptions {
    const confirmNodes =
        options?.confirmNodes === null
            ? null
            : Math.max(
                  1,
                  Math.trunc(options?.confirmNodes ?? 200_000)
              );
    const maxConfirmationNodes =
        confirmNodes == null || options?.maxConfirmationNodes === null
            ? null
            : Math.max(
                  confirmNodes,
                  Math.min(
                      20_000_000,
                      Math.trunc(
                          options?.maxConfirmationNodes ??
                              confirmNodes * 4
                      )
                  )
              );
    const multiPv = Math.max(
        1,
        Math.min(16, Math.trunc(options?.multiPv ?? 5))
    );
    const maxMultiPv = Math.max(
        multiPv,
        Math.min(16, Math.trunc(options?.maxMultiPv ?? 16))
    );
    return {
        movetimeMs: Math.max(1, Math.trunc(options?.movetimeMs ?? 200)),
        nodesPerPosition:
            options?.nodesPerPosition === null
                ? null
                : Math.max(
                      1,
                      Math.trunc(options?.nodesPerPosition ?? 100_000)
                  ),
        maxDepth:
            options?.maxDepth == null
                ? null
                : Math.max(1, Math.trunc(options.maxDepth)),
        engineTimeoutMs: Math.max(
            1_000,
            Math.trunc(options?.engineTimeoutMs ?? 30_000)
        ),
        minWinningChanceLoss: Math.max(
            0,
            Math.min(1, options?.minWinningChanceLoss ?? 0.03)
        ),
        fallbackMinCpLoss: Math.max(
            0,
            options?.fallbackMinCpLoss ?? 30
        ),
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
            Math.min(
                16,
                Math.trunc(
                    options?.maxAcceptedMoves ?? maxMultiPv
                )
            )
        ),
        maxAcceptedWinningChanceLoss: Math.max(
            0,
            Math.min(
                1,
                options?.maxAcceptedWinningChanceLoss ?? 0.1
            )
        ),
        fallbackMaxAcceptedCpLoss: Math.max(
            0,
            options?.fallbackMaxAcceptedCpLoss ?? 100
        ),
        verifyContinuations: options?.verifyContinuations ?? true,
        verificationMaxPlies: Math.max(
            1,
            Math.min(32, options?.verificationMaxPlies ?? 2)
        ),
        verificationMaxPositions: Math.max(
            1,
            Math.min(128, options?.verificationMaxPositions ?? 32)
        ),
        verificationNodesPerPosition:
            options?.verificationNodesPerPosition === null
                ? null
                : Math.max(
                      1,
                      options?.verificationNodesPerPosition ??
                          options?.nodesPerPosition ??
                          100_000
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
    signal?: AbortSignal
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
    result: MultiPvResult
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
    };
}

function repetitionPositionKey(fen: string): string | null {
    try {
        return new Chess(fen)
            .fen()
            .split(/\s+/)
            .slice(0, 4)
            .join(' ');
    } catch {
        return null;
    }
}

function completesThreefoldRepetition(
    previousFens: string[],
    rootFen: string,
    afterFen: string
): boolean {
    const afterKey = repetitionPositionKey(afterFen);
    if (!afterKey) return false;
    let occurrences = 0;
    for (const fen of [
        ...previousFens.slice(-256),
        rootFen,
        afterFen,
    ]) {
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
    rootFen: string
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
            completesThreefoldRepetition(
                previousFens,
                rootFen,
                after.fen()
            )
        ) {
            result.push({ moveUci, afterFen: after.fen() });
        }
    }
    return result;
}

function ruleDrawOutranksEvaluation(
    evaluation: Pick<EvalResult, 'bestMoveUci' | 'score' | 'wdl'>,
    repetitionMoves: RepetitionDrawMove[]
): boolean {
    if (
        repetitionMoves.some(
            (move) =>
                move.moveUci ===
                normalizeUci(evaluation.bestMoveUci)
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
        args.fen
    );
    if (
        repetitionMoves.length === 0 ||
        !ruleDrawOutranksEvaluation(
            args.evaluation,
            repetitionMoves
        )
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
        args.fen
    );
    if (repetitionMoves.length === 0) return args.result;
    const engineEvaluation = evalFromMultiPv(args.fen, args.result);
    if (!engineEvaluation) return args.result;
    const ruleIsBest = ruleDrawOutranksEvaluation(
        engineEvaluation,
        repetitionMoves
    );
    const repetitionMoveSet = new Set(
        repetitionMoves.map((move) => move.moveUci)
    );
    const engineLines = args.result.lines.filter(
        (line) =>
            !repetitionMoveSet.has(
                normalizeUci(line.pvUci[0] ?? '')
            )
    );
    const ruleLines: MultiPvLine[] = repetitionMoves.map(
        (move, index) => ({
            multipv: index + 1,
            pvUci: [move.moveUci],
            score: { type: 'cp', value: 0 },
            wdl: { win: 0, draw: 1_000, loss: 0 },
        })
    );
    const ordered = ruleIsBest
        ? [...ruleLines, ...engineLines]
        : [...engineLines, ...ruleLines];
    return {
        ...args.result,
        bestMoveUci:
            ordered[0]?.pvUci[0] ?? args.result.bestMoveUci,
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

async function evaluatePlayedMoveLoss(args: {
    engine: StockfishEngine;
    fen: string;
    moveUci: string;
    best: EvalResult;
    limit: ReturnType<typeof analysisLimit>;
    previousFens?: string[];
}): Promise<{
    loss: ReturnType<typeof evaluationLoss>;
    after: EvalResult;
} | null> {
    const parsed = parseUci(args.moveUci);
    if (!parsed) return null;
    let afterFen: string;
    try {
        const chess = new Chess(args.fen);
        const move = chess.move({
            from: parsed.from,
            to: parsed.to,
            promotion: parsed.promotion,
        });
        if (!move) return null;
        afterFen = chess.fen();
    } catch {
        return null;
    }

    const after = completesThreefoldRepetition(
        args.previousFens ?? [],
        args.fen,
        afterFen
    )
        ? ruleDrawEvaluation(afterFen)
        : await args.engine.evalPosition({
              fen: afterFen,
              ...args.limit,
          });
    return {
        loss: evaluationLoss(
            { score: args.best.score, wdl: args.best.wdl },
            {
                score: negateScore(after.score),
                wdl: reverseWdl(after.wdl),
            }
        ),
        after,
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
};

async function confirmCandidate(args: {
    engine: StockfishEngine;
    beforeFen: string;
    afterFen: string;
    solutionFen: string;
    minimumWinningChanceLoss: number;
    fallbackMinimumLossCp: number;
    multiPv: number;
    limit: ReturnType<typeof analysisLimit>;
    previousFens?: string[];
}): Promise<ConfirmationCandidateResult> {
    const multiPvResult = mergeRepetitionDrawMultiPv({
        result: await args.engine.analyzeMultiPv({
            fen: args.solutionFen,
            multiPv: args.multiPv,
            ...args.limit,
        }),
        fen: args.solutionFen,
        previousFens: args.previousFens ?? [],
    });
    const solutionEval = evalFromMultiPv(args.solutionFen, multiPvResult);
    if (!solutionEval || !solutionEval.bestMoveUci || !solutionEval.pvUci.length) {
        return { confirmed: false, multiPvResult };
    }

    const beforeEval =
        args.beforeFen === args.solutionFen
            ? solutionEval
            : await args.engine.evalPosition({
                  fen: args.beforeFen,
                  ...args.limit,
              });
    const afterEval = completesThreefoldRepetition(
        args.previousFens ?? [],
        args.beforeFen,
        args.afterFen
    )
        ? ruleDrawEvaluation(args.afterFen)
        : args.afterFen === args.solutionFen
            ? solutionEval
            : await args.engine.evalPosition({
                  fen: args.afterFen,
                  ...args.limit,
              });

    // At beforeFen the mover owns the engine score; after their move it is the
    // opponent's turn, so reverse both score and WDL into the mover's POV.
    const loss = evaluationLoss(
        { score: beforeEval.score, wdl: beforeEval.wdl },
        {
            score: negateScore(afterEval.score),
            wdl: reverseWdl(afterEval.wdl),
        }
    );
    const confirmed =
        qualifiesEvaluationLoss(loss, {
            minWinningChanceLoss: args.minimumWinningChanceLoss,
            fallbackMinCpLoss: args.fallbackMinimumLossCp,
        }) &&
        hasUsablePv(solutionEval);

    if (!confirmed) {
        return {
            confirmed: false,
            newEval: solutionEval,
            beforeEval,
            afterEval,
            multiPvResult,
            confirmedLossCp: loss.cp ?? undefined,
            confirmedWinningChanceLoss: loss.winningChance ?? undefined,
            loss,
        };
    }

    return {
        confirmed: true,
        newEval: solutionEval,
        beforeEval,
        afterEval,
        multiPvResult,
        confirmedLossCp: loss.cp ?? undefined,
        confirmedWinningChanceLoss: loss.winningChance ?? undefined,
        loss,
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
    }
): boolean {
    if (loss.winningChance != null) {
        const margin = Math.max(
            0.01,
            args.minimumWinningChanceLoss * 0.5
        );
        return (
            Math.abs(
                loss.winningChance - args.minimumWinningChanceLoss
            ) <= margin
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
    current: ReturnType<typeof evaluationLoss>
): boolean {
    if (
        previous.winningChance != null &&
        current.winningChance != null
    ) {
        return (
            Math.abs(previous.winningChance - current.winningChance) >
            0.015
        );
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
    multiPv: number;
    baseNodes: number;
    maxNodes: number;
    timeoutMs: number;
    previousFens?: string[];
    initialBestMoveUci: string;
    initialLoss: ReturnType<typeof evaluationLoss>;
    signal?: AbortSignal;
}): Promise<
    ConfirmationCandidateResult & {
        confirmationEvidence: AdaptiveConfirmationEvidence;
    }
> {
    const budgets = confirmationBudgets(args.baseNodes, args.maxNodes);
    let previousLoss = args.initialLoss;
    let previousQualifies = true;
    let previousBestMove = normalizeUci(args.initialBestMoveUci);
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
            limit: { nodes, timeoutMs: args.timeoutMs, signal: args.signal },
            previousFens: args.previousFens,
        });
        const complete = Boolean(
            latest.newEval &&
                latest.beforeEval &&
                latest.afterEval &&
                latest.loss
        );
        const currentBestMove = normalizeUci(
            latest.newEval?.bestMoveUci ?? ''
        );
        passes.push({
            nodes,
            bestMoveUci: currentBestMove || null,
            qualifies: latest.confirmed,
            cpLoss: latest.loss?.cp ?? null,
            winChanceLoss: latest.loss?.winningChance ?? null,
        });

        const disagreement =
            !complete ||
            previousQualifies !== latest.confirmed ||
            (latest.loss != null &&
                confirmationLossesDisagree(previousLoss, latest.loss));
        const bestMoveChanged =
            Boolean(previousBestMove) &&
            Boolean(currentBestMove) &&
            previousBestMove !== currentBestMove;
        const nearThreshold = latest.loss
            ? nearCoverageThreshold(latest.loss, args)
            : true;
        const isLast = index === budgets.length - 1;
        const needsMore =
            !isLast &&
            (disagreement || bestMoveChanged || nearThreshold);

        if (needsMore) {
            if (latest.loss) previousLoss = latest.loss;
            previousQualifies = latest.confirmed;
            previousBestMove = currentBestMove || previousBestMove;
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
        args.reason === 'SAVED'
            ? 'SAVED'
            : args.reason === 'ANALYSIS_INCOMPLETE' ||
                args.reason === 'VERIFICATION_UNSTABLE'
              ? 'UNRESOLVED'
              : 'NOT_SAVED';
    return {
        ply: args.ply,
        status,
        reason: args.reason,
        cpLoss: args.loss?.cp ?? null,
        winChanceLoss: args.loss?.winningChance ?? null,
        ...(args.confirmation
            ? { confirmation: args.confirmation }
            : {}),
    };
}

function normalizeUciList(
    bestMoveUci: string,
    accepted: string[] | undefined,
    maxAcceptedMoves: number
): string[] {
    const best = normalizeUci(bestMoveUci);
    const list = Array.isArray(accepted) ? accepted : [];
    const uniq = Array.from(
        new Set([best, ...list].map(normalizeUci).filter(Boolean))
    );
    return uniq.slice(0, Math.max(1, Math.trunc(maxAcceptedMoves)));
}

export function canonicalDecisionKey(
    moment: Pick<
        TrainingMomentCandidate,
        'sourceGameId' | 'sourcePgnHash' | 'decisionPly' | 'fen'
    >
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
            input as Record<string, unknown>
        ).sort()) {
            const item = (input as Record<string, unknown>)[key];
            if (item !== undefined) output[key] = canonicalize(item);
        }
        return output;
    };
    return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value)
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
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
    scorePov: 'w' | 'b'
): PovScore | null {
    if (!score) return null;
    if (score.type === 'cp') {
        return {
            kind: 'cp',
            cp: scorePov === 'w' ? score.value : -score.value,
            pov: 'WHITE',
        };
    }
    const winner =
        score.value >= 0 ? scorePov : otherSide(scorePov);
    const distance = Math.max(1, Math.abs(Math.trunc(score.value)));
    return {
        kind: 'mate',
        // UCI mate N is a move count. Convert it to a conservative exact ply
        // distance based on whether the score owner or the opponent mates.
        plies:
            score.value >= 0 ? distance * 2 - 1 : distance * 2,
        winner: winner === 'w' ? 'WHITE' : 'BLACK',
    };
}

function tablebaseScoreToWhitePov(
    wdl: 'WIN' | 'DRAW' | 'LOSS' | 'UNKNOWN',
    mover: 'w' | 'b',
    dtz?: number
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
    mover: 'w' | 'b'
): PovScore | null {
    if (evaluation.source === 'ENGINE') {
        return engineScoreToWhitePov(evaluation.score, mover);
    }
    if (evaluation.source === 'TABLEBASE') {
        return tablebaseScoreToWhitePov(
            evaluation.wdl,
            mover,
            evaluation.dtz
        );
    }
    return {
        kind: 'tablebase',
        wdl: 'DRAW',
        pov: 'WHITE',
    };
}

function verifiedEvaluationForLoss(
    evaluation: VerifiedMoveEvaluation
): {
    score: Score | null;
    wdl?: { win: number; draw: number; loss: number };
} {
    if (evaluation.source === 'ENGINE') {
        return {
            score: evaluation.score,
            ...(evaluation.wdl ? { wdl: evaluation.wdl } : {}),
        };
    }
    if (evaluation.source === 'RULE') {
        return {
            score: { type: 'cp', value: 0 },
            wdl: { win: 0, draw: 1_000, loss: 0 },
        };
    }
    const wdl =
        evaluation.wdl === 'WIN'
            ? { win: 1_000, draw: 0, loss: 0 }
            : evaluation.wdl === 'DRAW'
              ? { win: 0, draw: 1_000, loss: 0 }
              : evaluation.wdl === 'LOSS'
                ? { win: 0, draw: 0, loss: 1_000 }
                : undefined;
    return {
        score: { type: 'cp', value: 0 },
        ...(wdl ? { wdl } : {}),
    };
}

function assessmentsFromVerifiedTree(
    root: VerifiedSolutionNode,
    rootPositionHistory: string[],
    gradingPolicy: GradingPolicyV3
): SolutionMoveAssessmentInput[] {
    const assessments: SolutionMoveAssessmentInput[] = [];
    const visit = (
        node: VerifiedSolutionNode,
        positionHistory: string[]
    ) => {
        if (node.role === 'USER') {
            const bestEvaluation =
                node.branches.find((branch) => branch.best)
                    ?.evaluation ?? node.branches[0]?.evaluation;
            const side = sideToMoveFromFen(node.fen);
            const bestScoreAfter = bestEvaluation
                ? verifiedEvaluationToWhitePov(
                      bestEvaluation,
                      side
                  )
                : null;
            for (const branch of node.branches) {
                const scoreAfter = verifiedEvaluationToWhitePov(
                    branch.evaluation,
                    side
                );
                const gap = bestEvaluation
                    ? evaluationLoss(
                          verifiedEvaluationForLoss(bestEvaluation),
                          verifiedEvaluationForLoss(
                              branch.evaluation
                          )
                      )
                    : { cp: null, winningChance: null };
                const metrics = metricsFromPovScores({
                    moveUci: branch.moveUci,
                    originalMoveUci: '',
                    trainingSide: side,
                    bestScore: bestScoreAfter,
                    submittedScore: scoreAfter,
                    originalScore: null,
                });
                assessments.push({
                    positionKey: assessmentPositionKey(
                        node.fen,
                        positionHistory
                    ),
                    decisionIndex: Math.floor(node.ply / 2),
                    fen: node.fen,
                    moveUci: branch.moveUci,
                    source:
                        branch.evaluation.source === 'TABLEBASE'
                            ? 'TABLEBASE'
                            : 'PRECOMPUTED',
                    grade:
                        node.acceptanceFrontier?.moves.find(
                            (move) =>
                                move.moveUci === branch.moveUci
                        )?.tier ??
                        (branch.best
                            ? 'BEST'
                            : gap.cp != null &&
                                gap.cp <=
                                    gradingPolicy.strong.maxCpLoss
                              ? 'STRONG'
                              : 'GOOD'),
                    scoreAfter,
                    evidence: {
                        bestGapCp: gap.cp,
                        bestGapWinChance: gap.winningChance,
                        recoveredCp:
                            metrics.recoveredCp ?? null,
                        recoveredWinChance:
                            metrics.recoveredWinChance ?? null,
                        preservesOutcome:
                            metrics.preservesOutcome ?? null,
                        evaluation: branch.evaluation,
                    },
                });
            }
        }
        const childHistory = appendAssessmentHistory(
            positionHistory,
            node.fen
        );
        for (const branch of node.branches) {
            visit(branch.child, childHistory);
        }
    };
    visit(root, rootPositionHistory);
    return assessments;
}

function shallowAssessments(args: {
    fen: string;
    bestMoveUci: string;
    acceptedMovesUci: string[];
    evaluatedLines: MultiPvLine[];
    positionHistory: string[];
    acceptanceFrontier: AcceptanceFrontier;
}): SolutionMoveAssessmentInput[] {
    const side = sideToMoveFromFen(args.fen);
    const repetitionDraws = new Set(
        repetitionCompletingMoves(
            args.positionHistory,
            args.fen
        ).map((move) => move.moveUci)
    );
    const bestLine =
        args.evaluatedLines.find((line) => line.multipv === 1) ??
        args.evaluatedLines[0];
    return args.acceptedMovesUci.map((moveUci) => {
        const isRuleDraw = repetitionDraws.has(
            normalizeUci(moveUci)
        );
        const line = args.evaluatedLines.find(
            (candidate) =>
                normalizeUci(candidate.pvUci[0] ?? '') ===
                normalizeUci(moveUci)
        );
        const gap =
            bestLine && line
                ? evaluationLoss(
                      { score: bestLine.score, wdl: bestLine.wdl },
                      { score: line.score, wdl: line.wdl }
                  )
                : { cp: null, winningChance: null };
        return {
            positionKey: assessmentPositionKey(
                args.fen,
                args.positionHistory
            ),
            decisionIndex: 0,
            fen: args.fen,
            moveUci,
            source: 'PRECOMPUTED',
            grade:
                args.acceptanceFrontier.moves.find(
                    (move) =>
                        move.moveUci === normalizeUci(moveUci)
                )?.tier ??
                (normalizeUci(moveUci) ===
                normalizeUci(args.bestMoveUci)
                    ? 'BEST'
                    : 'GOOD'),
            scoreAfter: isRuleDraw
                ? {
                      kind: 'tablebase',
                      wdl: 'DRAW',
                      pov: 'WHITE',
                  }
                : engineScoreToWhitePov(
                      line?.score ?? bestLine?.score ?? null,
                      side
                  ),
            evidence: {
                bestGapCp: gap.cp,
                bestGapWinChance: gap.winningChance,
                depth: line?.depth,
                nodes: line?.nodes,
                wdl: line?.wdl,
                verification: 'SHALLOW_ONLY',
                ...(isRuleDraw
                    ? {
                          ruleTerminal:
                              'THREEFOLD_REPETITION',
                      }
                    : {}),
            },
        };
    });
}

async function solutionHash(
    input: Omit<SolutionRevisionInput, 'solutionHash' | 'evidence' | 'generatorVersion' | 'configHash'>
): Promise<string> {
    return solutionSemanticsHash(input);
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
    order: readonly T[]
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
    candidate: TrainingMomentCandidate
) {
    const key = canonicalDecisionKey(candidate);
    const index = moments.findIndex(
        (existing) => canonicalDecisionKey(existing) === key
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
            SOURCE_KIND_ORDER
        ),
        lessonKinds: orderedMetadataUnion(
            existing.lessonKinds,
            candidate.lessonKinds,
            LESSON_KIND_ORDER
        ),
        themes: Array.from(
            new Set([...existing.themes, ...candidate.themes])
        ).sort(),
    };
}

async function computeAcceptedMovesForPosition(args: {
    engine: StockfishEngine;
    fen: string;
    limit: ReturnType<typeof analysisLimit>;
    multiPv: number;
    acceptableLossCp: number;
    acceptableWinningChanceLoss: number;
    maxAcceptedMoves: number;
    bestMoveUci: string;
    precomputed?: MultiPvResult;
    previousFens?: string[];
    gradingPolicy: GradingPolicyV3;
}): Promise<{
    acceptedMovesUci: string[];
    evaluatedLines: MultiPvLine[];
    acceptanceFrontier: AcceptanceFrontier;
}> {
    const res = mergeRepetitionDrawMultiPv({
        result:
            args.precomputed ??
            (await args.engine.analyzeMultiPv({
                fen: args.fen,
                multiPv: args.multiPv,
                ...args.limit,
            })),
        fen: args.fen,
        previousFens: args.previousFens ?? [],
    });

    const lines = Array.isArray(res.lines) ? res.lines : [];
    const scored = lines
        .map((l) => {
            const first = (l.pvUci ?? [])[0];
            const cp = scoreToCp(l.score);
            return {
                uci: typeof first === 'string' ? normalizeUci(first) : '',
                cp,
                multipv: l.multipv ?? 999,
                line: l,
            };
        })
        .filter((x) => x.uci && typeof x.cp === 'number');

    if (scored.length === 0) {
        // Fallback: only accept best move.
        return {
            acceptedMovesUci: normalizeUciList(args.bestMoveUci, [], 1),
            evaluatedLines: lines,
            acceptanceFrontier: {
                version: 1,
                status: 'UNSTABLE',
                targetCutoffCp:
                    args.gradingPolicy.success.maxCpLoss,
                effectiveCutoffCp: null,
                boundaryGapCp: null,
                moves: [
                    {
                        moveUci: normalizeUci(args.bestMoveUci),
                        tier: 'BEST',
                    },
                ],
                firstRejectedMoveUci: null,
            },
        };
    }
    const acceptanceFrontier = acceptanceFrontierFromMultiPv({
        lines,
        requestedMultiPv: args.multiPv,
        alternativesComplete: res.alternativesComplete,
        policy: args.gradingPolicy,
    });
    const accepted = acceptanceFrontier.moves.map(
        (move) => move.moveUci
    );

    // Always include best move, normalize/dedupe/limit.
    return {
        acceptedMovesUci: normalizeUciList(
            args.bestMoveUci,
            accepted,
            args.maxAcceptedMoves
        ),
        evaluatedLines: lines,
        acceptanceFrontier,
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
    verificationCache: Map<
        string,
        Promise<ContinuationVerificationResult>
    >;
    signal?: AbortSignal;
}): Promise<TrainingMomentCandidate> {
    let verification: ContinuationVerificationResult | null = null;
    if (args.opts.verifyContinuations) {
        const key = [
            args.sourcePgnHash,
            args.decisionPly,
            args.fen,
        ].join('::');
        let pending = args.verificationCache.get(key);
        if (!pending) {
            pending = verifyConditionalContinuation({
                fen: args.fen,
                engine: args.engine,
                tablebase: args.tablebase,
                options: {
                    maxPlies: args.opts.verificationMaxPlies,
                    maxPositions: args.opts.verificationMaxPositions,
                    multiPv: args.opts.multiPv,
                    maxMultiPv: args.opts.maxMultiPv,
                    maxUserBranches: args.opts.maxAcceptedMoves,
                    maxAcceptedWinningChanceLoss:
                        args.opts.maxAcceptedWinningChanceLoss,
                    fallbackMaxAcceptedCpLoss:
                        args.opts.fallbackMaxAcceptedCpLoss,
                    gradingPolicy: args.opts.gradingPolicy,
                    nodesPerPosition:
                        args.opts.verificationNodesPerPosition,
                    maxDepth: args.opts.verificationMaxDepth,
                    movetimeMs: args.opts.movetimeMs,
                    timeoutMs: args.opts.engineTimeoutMs,
                    signal: args.signal,
                    previousFens: args.previousFens,
                },
            });
            args.verificationCache.set(key, pending);
        }
        verification = await pending;
    }

    const verifiedAccepted = verification?.acceptedMovesUci ?? [];
    let acceptanceFrontier: AcceptanceFrontier =
        verification?.root.acceptanceFrontier ??
        (verification?.root.alternativesComplete &&
        (verification.root.evidenceSource === 'TABLEBASE' ||
            verification.root.evidenceSource === 'RULE')
            ? {
                  version: 1,
                  status: 'STABLE',
                  targetCutoffCp:
                      args.opts.gradingPolicy.success.maxCpLoss,
                  effectiveCutoffCp: 0,
                  boundaryGapCp: null,
                  moves: verification.root.acceptedMovesUci.map(
                      (moveUci, index) => ({
                          moveUci,
                          tier: index === 0 ? 'BEST' : 'GOOD',
                      })),
                  firstRejectedMoveUci: null,
              }
            : args.acceptanceFrontier ?? {
                  version: 1,
                  status: 'UNSTABLE',
                  targetCutoffCp:
                      args.opts.gradingPolicy.success.maxCpLoss,
                  effectiveCutoffCp: null,
                  boundaryGapCp: null,
                  moves: [],
                  firstRejectedMoveUci: null,
              });
    const acceptedMovesUci = normalizeUciList(
        verification?.bestLineUci[0] ?? args.solutionEval.bestMoveUci,
        acceptanceFrontier.moves.length > 0
            ? acceptanceFrontier.moves.map((move) => move.moveUci)
            : verifiedAccepted.length > 0
              ? verifiedAccepted
              : args.acceptedMovesUci,
        args.opts.maxAcceptedMoves
    );
    const bestMoveUci =
        normalizeUci(
            verification?.bestLineUci[0] ??
                args.solutionEval.bestMoveUci
        ) || acceptedMovesUci[0]!;
    const bestLineUci =
        verification?.bestLineUci.length
            ? verification.bestLineUci
            : args.solutionEval.pvUci;
    const moveAssessments =
        verification && verification.root.acceptedMovesUci.length > 0
            ? assessmentsFromVerifiedTree(
                  verification.root,
                  args.previousFens,
                  args.opts.gradingPolicy
              )
            : shallowAssessments({
                  fen: args.fen,
                  bestMoveUci,
                  acceptedMovesUci,
                  evaluatedLines: args.evaluatedLines,
                  positionHistory: args.previousFens,
                  acceptanceFrontier,
              });
    acceptanceFrontier = {
        ...acceptanceFrontier,
        moves: acceptanceFrontier.moves.map((move) => ({
            ...move,
            tier:
                moveAssessments.find(
                    (assessment) =>
                        assessment.decisionIndex === 0 &&
                        normalizeUci(assessment.moveUci) ===
                            normalizeUci(move.moveUci)
                )?.grade ?? move.tier,
        })),
    };
    const rootBestIsRuleDraw = repetitionCompletingMoves(
        args.previousFens,
        args.fen
    ).some(
        (move) =>
            move.moveUci === normalizeUci(bestMoveUci)
    );
    const rootSide = sideToMoveFromFen(args.fen);
    const verifiedRootBestEvaluation =
        verification?.root.branches.find((branch) => branch.best)
            ?.evaluation ??
        verification?.root.branches[0]?.evaluation;
    const exactVerifiedRootScore =
        verifiedRootBestEvaluation?.source === 'RULE' ||
        verifiedRootBestEvaluation?.source === 'TABLEBASE'
            ? verifiedEvaluationToWhitePov(
                  verifiedRootBestEvaluation,
                  rootSide
              )
            : null;
    const scoreAtStart =
        exactVerifiedRootScore ??
        (!verification && rootBestIsRuleDraw
            ? ({
                  kind: 'tablebase',
                  wdl: 'DRAW',
                  pov: 'WHITE',
              } as const)
            : engineScoreToWhitePov(
                  args.solutionEval.score,
                  rootSide
              ));
    const verificationStatus =
        verification?.status ??
        (acceptanceFrontier.status === 'STABLE'
            ? ('VERIFIED' as const)
            : ('AMBIGUOUS' as const));
    const solutionShape =
        acceptanceFrontier.status !== 'STABLE'
            ? 'OPEN'
            : acceptedMovesUci.length > 1
              ? 'MULTIPLE'
              : 'UNIQUE';
    const solutionCore: Omit<
        SolutionRevisionInput,
        'solutionHash' | 'evidence' | 'generatorVersion' | 'configHash'
    > = {
        verificationStatus,
        solutionShape,
        gradingStrategy:
            verification?.root.evidenceSource === 'TABLEBASE'
                ? 'TABLEBASE'
                : 'PRECOMPUTED',
        continuationShape:
            bestLineUci.length > 1
                ? 'CONDITIONAL_LINE'
                : 'SINGLE_DECISION',
        trainable:
            verificationStatus === 'VERIFIED' &&
            acceptanceFrontier.status === 'STABLE' &&
            !acceptedMovesUci.some(
                (move) =>
                    normalizeUci(move) ===
                    normalizeUci(args.originalMoveUci)
            ),
        bestMoveUci,
        acceptedMovesUci,
        acceptanceFrontier,
        moveAssessments,
        bestLineUci,
        solutionTree:
            verification?.root ?? {
                fen: args.fen,
                ply: 0,
                role: 'USER',
                evidenceSource: 'ENGINE',
                acceptedMovesUci,
                alternativesComplete:
                    acceptanceFrontier.status === 'STABLE',
                branches: [],
                ...(acceptanceFrontier.status === 'STABLE'
                    ? {}
                    : { stopReason: 'NO_STABLE_LINE' }),
            },
        scoreAtStart,
        playedMoveScore: args.originalScoreAfter,
        targetOutcome: {
            kind: 'MAXIMIZE_WINNING_CHANCE',
            score: scoreAtStart,
        },
        gradingPolicy: args.opts.gradingPolicy,
    };
    const solution: SolutionRevisionInput = {
        ...solutionCore,
        solutionHash: await solutionHash(solutionCore),
        evidence: {
            verifier: verification,
            extraction: {
                originalLoss: args.originalLoss,
                rootEvaluation: {
                    score: args.solutionEval.score,
                    wdl: args.solutionEval.wdl,
                    depth: args.solutionEval.depth,
                    nodes: args.solutionEval.nodes,
                    selDepth: args.solutionEval.selDepth,
                    timeMs: args.solutionEval.timeMs,
                },
            },
        },
        generatorVersion: 'backranq-training-extractor-v3',
        configHash: args.configHash,
    };
    const confidence =
        verificationStatus === 'VERIFIED'
            ? 0.98
            : verificationStatus === 'AMBIGUOUS'
              ? 0.75
              : verificationStatus === 'UNSTABLE'
                ? 0.35
                : 0;
    const phase = phaseFromPosition({
        fen: args.fen,
        ply: args.decisionPly,
    }).toUpperCase() as 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';

    return {
        sourceGameId: args.canonicalSourceGameId,
        sourcePgnHash: args.sourcePgnHash,
        sourceProvider: args.game.provider,
        sourcePlayedAt: args.game.playedAt,
        decisionPly: args.decisionPly,
        fen: args.fen,
        positionHistory: args.previousFens.slice(-256),
        sideToMove: sideToMoveFromFen(args.fen),
        originalMoveUci: normalizeUci(args.originalMoveUci),
        sourceKinds: [args.sourceKind],
        lessonKinds: [args.lessonKind],
        themes: Array.from(
            new Set(args.themes.map((theme) => theme.trim()).filter(Boolean))
        ).sort(),
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
        confidence,
        phase,
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
        | ReadonlyMap<string, string>
        | Readonly<Record<string, string>>;
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
    /**
     * Landing-only fast path. Returns immediately after the first fully VERIFIED
     * candidate is built. Canonical full-game extraction leaves this disabled.
     */
    stopAfterFirstVerified?: boolean;
}): Promise<TrainingMomentExtractionResult> {
    if (args.signal?.aborted) throw new Error('Analysis aborted');
    const opts = resolveOptions(args.options);
    let engineIdentity: Awaited<
        ReturnType<NonNullable<StockfishEngine['getIdentity']>>
    > | null = null;
    try {
        engineIdentity = (await args.engine.getIdentity?.()) ?? null;
    } catch {
        // Missing identity is explicit in the config snapshot and never guessed.
    }
    const configSnapshot: Record<string, unknown> = {
        version: 3,
        engine: engineIdentity,
        extractor: opts,
    };
    const configHash =
        args.analysisConfigHash ??
        (await sha256Hex(stableCanonicalStringify(configSnapshot)));
    const moments: TrainingMomentCandidate[] = [];
    const manifests: ExtractionCompletionManifest[] = [];
    const analysisMap = new Map<string, GameAnalysis>();
    const verificationCache = new Map<
        string,
        Promise<ContinuationVerificationResult>
    >();
    const selected = args.games.filter((g) => args.selectedGameIds.has(g.id));

    for (let gi = 0; gi < selected.length; gi++) {
        if (args.signal?.aborted) throw new Error('Analysis aborted');
        const game = selected[gi];
        if (!game) continue;
        const canonicalSourceGameIdValue = canonicalSourceGameId(
            args.canonicalSourceGameIdByGameId,
            game.id
        );
        const gameSourcePgnHash = await sourcePgnHash(game.pgn);

        const chess = new Chess();
        try {
            chess.loadPgn(game.pgn, { strict: false });
        } catch {
            manifests.push({
                version: 1,
                complete: false,
                sourceGameId: canonicalSourceGameIdValue,
                sourcePgnHash: gameSourcePgnHash,
                scannedPlies: 0,
                expectedPlies: 0,
                termination: 'INVALID_SOURCE',
                errors: ['Source PGN could not be parsed'],
            });
            continue;
        }

        // Use verbose history so we replay by from/to (not SAN), which avoids "Invalid move: …" issues.
        const movesVerbose = chess.history({ verbose: true }) as Move[];
        const plyCount = movesVerbose.length;
        const userColor = userColorForGame(game);
        if (!userColor) {
            manifests.push({
                version: 1,
                complete: false,
                sourceGameId: canonicalSourceGameIdValue,
                sourcePgnHash: gameSourcePgnHash,
                scannedPlies: 0,
                expectedPlies: plyCount,
                termination: 'USER_SIDE_UNRESOLVED',
                errors: ['Training side could not be resolved for source game'],
            });
            continue;
        }
        // Determine starting position.
        const startFen = extractStartFenFromPgn(game.pgn);
        let replay: Chess;
        try {
            replay = startFen ? new Chess(startFen) : new Chess();
        } catch {
            replay = new Chess();
        }

        // Initialize analysis for this game if requested
        const gameAnalysis: AnalyzedMove[] = [];
        const whiteMoveAccuracies: number[] = [];
        const blackMoveAccuracies: number[] = [];
        const extractionErrors: string[] = [];
        const decisionReceipts = new Map<
            number,
            TrainingDecisionReceipt
        >();
        const lookaheadOwnedUserDecisionPlies = new Set<number>();

        for (let ply = 0; ply < plyCount; ply++) {
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            args.onProgress?.({
                gameId: game.id,
                gameIndex: gi,
                gameCount: selected.length,
                ply,
                plyCount,
            });

            const fenBefore = replay.fen();
            const stm = sideToMoveFromFen(fenBefore);
            const moverColor = stm; // side to move is making the played move
            const mv = movesVerbose[ply];
            if (!mv) break;
            const hasDecision = replay.moves().length > 1;

            // Determine if this move is by user or opponent
            const isUserMove = moverColor === userColor;
            const isOpponentMove = !isUserMove;
            const previousFens = movesVerbose
                .slice(0, ply)
                .map((move) => move.before);
            if (
                isUserMove &&
                !lookaheadOwnedUserDecisionPlies.has(ply)
            ) {
                decisionReceipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: hasDecision
                            ? 'ANALYSIS_INCOMPLETE'
                            : 'FORCED_MOVE',
                    })
                );
            }

            // Eval at position before the move (best play).
            const bestAtBefore =
                promoteRepetitionDrawEvaluation({
                    evaluation: await args.engine.evalPosition({
                        fen: fenBefore,
                        ...analysisLimit(opts, false, args.signal),
                    }),
                    fen: fenBefore,
                    previousFens,
            });
            if (!hasUsablePv(bestAtBefore)) {
                if (hasDecision) {
                    extractionErrors.push(
                        `Ply ${ply}: root analysis produced no usable principal variation`
                    );
                }
                // Apply played move and continue (avoid dead PVs).
                try {
                    const played = replay.move({
                        from: mv.from,
                        to: mv.to,
                        promotion: mv.promotion,
                    });
                    if (!played) break;

                    // Still record the move with partial info if analysis is requested
                    if (opts.returnAnalysis) {
                        const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
                        gameAnalysis.push({
                            ply,
                            san: mv.san,
                            uci,
                            classification: 'good', // Assume okay if no deep analysis
                            evalBefore: bestAtBefore.score,
                            evalAfter: null,
                            cpLoss: 0,
                            bestMoveUci: bestAtBefore.bestMoveUci,
                        });
                    }
                } catch {
                    break;
                }
                continue;
            }

            const bestCpBefore = scoreToCp(bestAtBefore.score);

            // Apply played move.
            try {
                const played = replay.move({
                    from: mv.from,
                    to: mv.to,
                    promotion: mv.promotion,
                });
                if (!played) break;
            } catch {
                // If we somehow desync (bad PGN), stop analyzing this game.
                break;
            }
            const fenAfter = replay.fen();

            // Eval after played move (opponent to move).
            const playedMoveCompletesThreefold =
                completesThreefoldRepetition(
                    previousFens,
                    fenBefore,
                    fenAfter
                );
            const bestAtAfter: EvalResult =
                playedMoveCompletesThreefold
                    ? ruleDrawEvaluation(fenAfter)
                    : await args.engine.evalPosition({
                          fen: fenAfter,
                          ...analysisLimit(opts, false, args.signal),
                      });

            const afterCpStm = scoreToCp(bestAtAfter.score);
            if (bestCpBefore == null || afterCpStm == null) {
                if (hasDecision) {
                    extractionErrors.push(
                        `Ply ${ply}: decision analysis produced no comparable score`
                    );
                }
                continue;
            }

            const originalScoreBefore = engineScoreToWhitePov(
                bestAtBefore.score,
                stm
            );
            const originalScoreAfter: PovScore | null =
                playedMoveCompletesThreefold
                    ? {
                          kind: 'tablebase',
                          wdl: 'DRAW',
                          pov: 'WHITE',
                      }
                    : engineScoreToWhitePov(
                          bestAtAfter.score,
                          otherSide(stm)
                      );
            if (!originalScoreBefore || !originalScoreAfter) {
                if (hasDecision) {
                    extractionErrors.push(
                        `Ply ${ply}: decision analysis produced no canonical POV score`
                    );
                }
                continue;
            }
            const moveLoss = evaluationLoss(
                { score: bestAtBefore.score, wdl: bestAtBefore.wdl },
                {
                    score: negateScore(bestAtAfter.score),
                    wdl: reverseWdl(bestAtAfter.wdl),
                }
            );
            const isMeaningfulMistake = qualifiesEvaluationLoss(moveLoss, {
                minWinningChanceLoss: opts.minWinningChanceLoss,
                fallbackMinCpLoss: opts.fallbackMinCpLoss,
            });
            if (
                isUserMove &&
                hasDecision &&
                !lookaheadOwnedUserDecisionPlies.has(ply)
            ) {
                decisionReceipts.set(
                    ply,
                    decisionReceipt({
                        ply,
                        reason: isMeaningfulMistake
                            ? 'ANALYSIS_INCOMPLETE'
                            : 'BELOW_COVERAGE_THRESHOLD',
                        loss: moveLoss,
                    })
                );
            }

            // Calculate swing from the mover's perspective
            const beforeCpMover = perspectiveCp(bestCpBefore, moverColor, stm);
            const afterCpMover = perspectiveCp(
                afterCpStm,
                moverColor,
                stm === 'w' ? 'b' : 'w'
            ); // side-to-move flipped

            const swing = beforeCpMover - afterCpMover; // positive means mover got worse (blundered)

            // Record move analysis if requested
            if (opts.returnAnalysis) {
                const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
                const isBestMove = uci === bestAtBefore.bestMoveUci;
                const wasAlreadyLost = beforeCpMover < -300;

                // Lichess-style move accuracy is based on win% drop (not cp loss).
                // Exclude forced moves (only one legal move) since there was no choice.
                let moveAccuracy: number | undefined;
                try {
                    const legalCount = new Chess(fenBefore).moves().length;
                    const isForced = legalCount <= 1;
                    if (!isForced) {
                        const acc = lichessMoveAccuracyFromCps({
                            beforeCp: beforeCpMover,
                            afterCp: afterCpMover,
                        }).accuracy;
                        moveAccuracy = acc;
                        if (moverColor === 'w') whiteMoveAccuracies.push(acc);
                        else blackMoveAccuracies.push(acc);
                    }
                } catch {
                    // If we can't enumerate legal moves for some reason, fall back to including it.
                    const acc = lichessMoveAccuracyFromCps({
                        beforeCp: beforeCpMover,
                        afterCp: afterCpMover,
                    }).accuracy;
                    moveAccuracy = acc;
                    if (moverColor === 'w') whiteMoveAccuracies.push(acc);
                    else blackMoveAccuracies.push(acc);
                }

                // Check if the move involves tactical elements
                const { isCheck, isCapture } = tacticalMoveFacts(
                    new Chess(fenBefore),
                    uci
                );
                const hasTacticalPv = bestAtBefore.pvUci.length >= 3;

                // Determine classification
                const classification = classifyMove({
                    cpLoss: Math.max(0, swing),
                    isBestMove,
                    isSacrifice: isCapture && swing <= 0, // Captured but didn't lose eval
                    foundDeepTactic: hasTacticalPv && (isCheck || isCapture),
                    isBookMove: false,
                    wasAlreadyLost,
                });

                const cpLoss = Math.max(0, swing);

                const analyzedMove: AnalyzedMove = {
                    ply,
                    san: mv.san,
                    uci,
                    classification,
                    evalBefore: bestAtBefore.score,
                    evalAfter: bestAtAfter.score,
                    cpLoss,
                    accuracy: moveAccuracy,
                    bestMoveUci: bestAtBefore.bestMoveUci,
                    bestMoveSan:
                        uciToSan(fenBefore, bestAtBefore.bestMoveUci) ??
                        undefined,
                };

                gameAnalysis.push(analyzedMove);
            }

            // User decision: replay the position before their own mistake.
            if (
                isUserMove &&
                hasDecision &&
                isMeaningfulMistake &&
                !lookaheadOwnedUserDecisionPlies.has(ply)
            ) {
                {
                    // Themes describe the lesson; they never decide whether a
                    // real mistake is trainable.
                    const hasTacticalTheme = pvContainsTactic(
                        fenBefore,
                        bestAtBefore.pvUci,
                        opts.themeLookaheadPlies
                    );

                    {
                        const lessonKind: TrainingLessonKind =
                            Math.abs(beforeCpMover) <=
                                DRAWISH_POSITION_ABS_CP &&
                            afterCpMover < CLEARLY_WORSE_POSITION_CP
                                ? 'SAVE_DRAW'
                                : swing < BIG_MISTAKE_CLASSIFICATION_CP &&
                            beforeCpMover >= PRESERVE_WIN_MIN_POSITION_CP &&
                            swing >= PRESERVE_WIN_MIN_LOSS_CP
                                  ? 'PRESERVE_WIN'
                                  : 'AVOID_MISTAKE';
                        {
                            // Optional confirmation pass
                            let finalEval = bestAtBefore;
                            let confirmed = true;
                            let confirmedMultiPv: MultiPvResult | undefined;
                            let verifiedSwing = swing;
                            let verifiedOriginalScoreBefore =
                                originalScoreBefore;
                            let verifiedOriginalScoreAfter =
                                originalScoreAfter;
                            let verifiedOriginalLoss = moveLoss;
                            let confirmationEvidence:
                                | AdaptiveConfirmationEvidence
                                | undefined;
                            if (
                                opts.confirmNodes != null ||
                                (opts.confirmMovetimeMs != null &&
                                    opts.confirmMovetimeMs > opts.movetimeMs)
                            ) {
                                args.onProgress?.({
                                    gameId: game.id,
                                    gameIndex: gi,
                                    gameCount: selected.length,
                                    ply,
                                    plyCount,
                                    phase: 'confirming',
                                });
                                const result =
                                    opts.confirmNodes != null &&
                                    opts.maxConfirmationNodes != null
                                        ? await confirmCandidateAdaptively({
                                              engine: args.engine,
                                              beforeFen: fenBefore,
                                              afterFen: fenAfter,
                                              solutionFen: fenBefore,
                                              minimumWinningChanceLoss:
                                                  opts.minWinningChanceLoss,
                                              fallbackMinimumLossCp:
                                                  opts.fallbackMinCpLoss,
                                              multiPv: opts.multiPv,
                                              baseNodes: opts.confirmNodes,
                                              maxNodes:
                                                  opts.maxConfirmationNodes,
                                              timeoutMs:
                                                  opts.engineTimeoutMs,
                                              signal: args.signal,
                                              previousFens,
                                              initialBestMoveUci:
                                                  bestAtBefore.bestMoveUci,
                                              initialLoss: moveLoss,
                                          })
                                        : await confirmCandidate({
                                    engine: args.engine,
                                    beforeFen: fenBefore,
                                    afterFen: fenAfter,
                                    solutionFen: fenBefore,
                                    minimumWinningChanceLoss:
                                        opts.minWinningChanceLoss,
                                    fallbackMinimumLossCp:
                                        opts.fallbackMinCpLoss,
                                    multiPv: opts.multiPv,
                                    limit: analysisLimit(
                                        opts,
                                        true,
                                        args.signal
                                    ),
                                    previousFens,
                                });
                                confirmationEvidence =
                                    'confirmationEvidence' in result
                                        ? (
                                              result as {
                                                  confirmationEvidence: AdaptiveConfirmationEvidence;
                                              }
                                          ).confirmationEvidence
                                        : undefined;
                                confirmed = result.confirmed;
                                if (
                                    !result.newEval ||
                                    !result.beforeEval ||
                                    !result.afterEval ||
                                    !result.loss
                                ) {
                                    extractionErrors.push(
                                        `Ply ${ply}: confirmation produced incomplete evidence`
                                    );
                                }
                                if (result.newEval) finalEval = result.newEval;
                                confirmedMultiPv = result.multiPvResult;
                                if (result.confirmedLossCp != null)
                                    verifiedSwing = result.confirmedLossCp;
                                const confirmedBeforeScore =
                                    result.beforeEval
                                        ? engineScoreToWhitePov(
                                              result.beforeEval.score,
                                              stm
                                          )
                                        : null;
                                const confirmedAfterScore =
                                    playedMoveCompletesThreefold
                                        ? ({
                                              kind: 'tablebase',
                                              wdl: 'DRAW',
                                              pov: 'WHITE',
                                          } satisfies PovScore)
                                        : result.afterEval
                                        ? engineScoreToWhitePov(
                                              result.afterEval.score,
                                              otherSide(stm)
                                          )
                                        : null;
                                if (
                                    confirmedBeforeScore &&
                                    confirmedAfterScore &&
                                    result.loss
                                ) {
                                    verifiedOriginalScoreBefore =
                                        confirmedBeforeScore;
                                    verifiedOriginalScoreAfter =
                                        confirmedAfterScore;
                                    verifiedOriginalLoss = result.loss;
                                }
                            }

                            if (confirmed) {
                                const tagsAndSeverity = tagsForCandidate({
                                    fenBefore,
                                    fenAfter,
                                    moverColor,
                                    bestAtBefore: finalEval,
                                    bestAtAfter,
                                    swingCp: verifiedSwing,
                                });
                                const tags = new Set<string>(
                                    tagsAndSeverity.tags
                                );
                                if (hasTacticalTheme) tags.add('tactical');

                                let acceptedMovesUci: string[] | undefined =
                                    undefined;
                                let evaluatedLines: MultiPvLine[] =
                                    confirmedMultiPv?.lines ?? [];
                                let acceptanceFrontier:
                                    | AcceptanceFrontier
                                    | undefined;
                                let acceptedMovesError = false;
                                try {
                                    const acceptedRes =
                                        await computeAcceptedMovesForPosition({
                                            engine: args.engine,
                                            fen: fenBefore,
                                            limit: confirmedMultiPv
                                                ? analysisLimit(
                                                      opts,
                                                      true,
                                                      args.signal
                                                  )
                                                : analysisLimit(
                                                      opts,
                                                      false,
                                                      args.signal
                                                  ),
                                            multiPv: opts.multiPv,
                                            acceptableLossCp:
                                                opts.fallbackMaxAcceptedCpLoss,
                                            acceptableWinningChanceLoss:
                                                opts.maxAcceptedWinningChanceLoss,
                                            maxAcceptedMoves:
                                                opts.maxAcceptedMoves,
                                            bestMoveUci: finalEval.bestMoveUci,
                                            precomputed: confirmedMultiPv,
                                            previousFens,
                                            gradingPolicy:
                                                opts.gradingPolicy,
                                        });
                                    acceptedMovesUci =
                                        acceptedRes.acceptedMovesUci;
                                    evaluatedLines =
                                        acceptedRes.evaluatedLines;
                                    acceptanceFrontier =
                                        acceptedRes.acceptanceFrontier;
                                } catch {
                                    // Ignore MultiPV failures; fall back to single-solution.
                                    acceptedMovesError = true;
                                }

                                const acceptedNormalized = acceptedMovesError
                                    ? normalizeUciList(
                                          finalEval.bestMoveUci,
                                          [],
                                          1
                                      )
                                    : normalizeUciList(
                                          finalEval.bestMoveUci,
                                          acceptedMovesUci,
                                          opts.maxAcceptedMoves
                                      );
                                const isMulti = acceptedNormalized.length > 1;
                                if (isMulti) tags.add('multiSolution');
                                else tags.delete('multiSolution');
                                if (acceptedMovesError)
                                    tags.add('acceptedMovesMissing');

                                const moment = await buildTrainingMoment({
                                    game,
                                    canonicalSourceGameId:
                                        canonicalSourceGameIdValue,
                                    sourcePgnHash: gameSourcePgnHash,
                                    decisionPly: ply,
                                    fen: fenBefore,
                                    originalMoveUci: `${mv.from}${mv.to}${
                                        mv.promotion ?? ''
                                    }`,
                                    originalScoreBefore:
                                        verifiedOriginalScoreBefore,
                                    originalScoreAfter:
                                        verifiedOriginalScoreAfter,
                                    originalLoss: verifiedOriginalLoss,
                                    sourceKind: 'MY_MISTAKE',
                                    lessonKind,
                                    themes: Array.from(tags),
                                    solutionEval: finalEval,
                                    acceptedMovesUci: acceptedNormalized,
                                    evaluatedLines,
                                    acceptanceFrontier,
                                    engine: args.engine,
                                    tablebase: args.tablebase,
                                    opts,
                                    configHash,
                                    previousFens: movesVerbose
                                        .slice(0, ply)
                                        .map((move) => move.before),
                                    verificationCache,
                                    signal: args.signal,
                                });
                                storeCanonicalTrainingMoment(
                                    moments,
                                    moment
                                );
                                if (
                                    args.stopAfterFirstVerified &&
                                    isLandingReadyTrainingMoment(moment)
                                ) {
                                    return {
                                        moments: [moment],
                                        manifests: [],
                                        configSnapshot,
                                        configHash,
                                        analysis: opts.returnAnalysis
                                            ? analysisMap
                                            : undefined,
                                    };
                                }
                                decisionReceipts.set(
                                    ply,
                                    decisionReceipt({
                                        ply,
                                        reason: moment.solution.trainable
                                            ? 'SAVED'
                                            : 'VERIFICATION_UNSTABLE',
                                        loss: verifiedOriginalLoss,
                                        confirmation:
                                            confirmationEvidence,
                                    })
                                );
                            } else {
                                decisionReceipts.set(
                                    ply,
                                    decisionReceipt({
                                        ply,
                                        reason:
                                            confirmationEvidence?.termination ===
                                                'MAX_BUDGET_UNSTABLE' ||
                                            confirmationEvidence?.termination ===
                                                'INCOMPLETE'
                                                ? 'VERIFICATION_UNSTABLE'
                                                : 'BELOW_THRESHOLD_AFTER_CONFIRMATION',
                                        loss: verifiedOriginalLoss,
                                        confirmation:
                                            confirmationEvidence,
                                    })
                                );
                            }
                        }
                    }
                }
            }

            // User decision: after an opponent mistake, retain the moment only
            // when the user's real reply was outside the practical tolerance.
            if (
                isOpponentMove &&
                hasDecision &&
                isMeaningfulMistake // opponent made a meaningful error
            ) {
                // Now we need to check: did the user punish it?
                // Look at the NEXT move (user's response) and see if they found the best move
                const nextPly = ply + 1;
                if (nextPly < plyCount) {
                    const userResponseMv = movesVerbose[nextPly];
                    if (userResponseMv) {
                        const userResponseUci = `${userResponseMv.from}${
                            userResponseMv.to
                        }${userResponseMv.promotion ?? ''}`;
                        const userResponsePreviousFens = movesVerbose
                            .slice(0, nextPly)
                            .map((move) => move.before);
                        const userResponseCompletesThreefold =
                            completesThreefoldRepetition(
                                userResponsePreviousFens,
                                fenAfter,
                                userResponseMv.after
                            );

                        // Grade the actual reply by outcome, not by exact UCI
                        // equality. A second/equivalent engine line is a valid
                        // punishment and must not create a false exercise.
                        const userResponseAssessment =
                            await evaluatePlayedMoveLoss({
                                engine: args.engine,
                                fen: fenAfter,
                                moveUci: userResponseUci,
                                best: bestAtAfter,
                                limit: analysisLimit(
                                    opts,
                                    false,
                                    args.signal
                                ),
                                previousFens: userResponsePreviousFens,
                            });
                        const userPunished =
                            userResponseAssessment == null ||
                            isWithinEvaluationLoss(
                                userResponseAssessment.loss,
                                {
                                    maxWinningChanceLoss:
                                        opts.maxAcceptedWinningChanceLoss,
                                    fallbackMaxCpLoss:
                                        opts.fallbackMaxAcceptedCpLoss,
                                }
                            );

                        if (!userPunished && userResponseAssessment) {
                            {
                                const hasTacticalTheme = pvContainsTactic(
                                    fenAfter,
                                    bestAtAfter.pvUci,
                                    opts.themeLookaheadPlies
                                );

                                if (hasUsablePv(bestAtAfter)) {
                                    // This lookahead owns the next user decision
                                    // end-to-end. The normal user-ply pass still
                                    // records game-review data, but must not
                                    // confirm or extract the same decision again.
                                    lookaheadOwnedUserDecisionPlies.add(
                                        nextPly
                                    );
                                    // Optional confirmation pass
                                    let finalEval = bestAtAfter;
                                    let confirmed = true;
                                    let confirmedMultiPv:
                                        | MultiPvResult
                                        | undefined;
                                    let finalPlayedEval =
                                        userResponseAssessment.after;
                                    let verifiedResponseLoss =
                                        userResponseAssessment.loss;
                                    let verifiedSwing =
                                        userResponseAssessment.loss.cp ?? 0;
                                    let confirmationEvidence:
                                        | AdaptiveConfirmationEvidence
                                        | undefined;
                                    let responseScoreBefore =
                                        engineScoreToWhitePov(
                                            bestAtAfter.score,
                                            userColor
                                        );
                                    let responseScoreAfter =
                                        userResponseCompletesThreefold
                                            ? ({
                                                  kind: 'tablebase',
                                                  wdl: 'DRAW',
                                                  pov: 'WHITE',
                                              } satisfies PovScore)
                                            : engineScoreToWhitePov(
                                                  userResponseAssessment.after
                                                      .score,
                                                  otherSide(userColor)
                                              );
                                    if (
                                        opts.confirmNodes != null ||
                                        (opts.confirmMovetimeMs != null &&
                                            opts.confirmMovetimeMs >
                                                opts.movetimeMs)
                                    ) {
                                        args.onProgress?.({
                                            gameId: game.id,
                                            gameIndex: gi,
                                            gameCount: selected.length,
                                            ply: nextPly,
                                            plyCount,
                                            phase: 'confirming',
                                        });
                                        const result =
                                            opts.confirmNodes != null &&
                                            opts.maxConfirmationNodes != null
                                                ? await confirmCandidateAdaptively(
                                                      {
                                                          engine: args.engine,
                                                          beforeFen:
                                                              fenAfter,
                                                          afterFen:
                                                              userResponseMv.after,
                                                          solutionFen:
                                                              fenAfter,
                                                          minimumWinningChanceLoss:
                                                              opts.minWinningChanceLoss,
                                                          fallbackMinimumLossCp:
                                                              opts.fallbackMinCpLoss,
                                                          multiPv:
                                                              opts.multiPv,
                                                          baseNodes:
                                                              opts.confirmNodes,
                                                          maxNodes:
                                                              opts.maxConfirmationNodes,
                                                          timeoutMs:
                                                              opts.engineTimeoutMs,
                                                          signal: args.signal,
                                                          previousFens:
                                                              userResponsePreviousFens,
                                                          initialBestMoveUci:
                                                              bestAtAfter.bestMoveUci,
                                                          initialLoss:
                                                              userResponseAssessment.loss,
                                                      }
                                                  )
                                                : await confirmCandidate({
                                            engine: args.engine,
                                            beforeFen: fenAfter,
                                            afterFen: userResponseMv.after,
                                            solutionFen: fenAfter,
                                            minimumWinningChanceLoss:
                                                opts.minWinningChanceLoss,
                                            fallbackMinimumLossCp:
                                                opts.fallbackMinCpLoss,
                                            multiPv: opts.multiPv,
                                            limit: analysisLimit(
                                                opts,
                                                true,
                                                args.signal
                                            ),
                                            previousFens:
                                                userResponsePreviousFens,
                                        });
                                        confirmationEvidence =
                                            'confirmationEvidence' in result
                                                ? (
                                                      result as {
                                                          confirmationEvidence: AdaptiveConfirmationEvidence;
                                                      }
                                                  ).confirmationEvidence
                                                : undefined;
                                        confirmed = result.confirmed;
                                        if (
                                            !result.newEval ||
                                            !result.beforeEval ||
                                            !result.afterEval ||
                                            !result.loss
                                        ) {
                                            extractionErrors.push(
                                                `Ply ${nextPly}: missed-opportunity confirmation produced incomplete evidence`
                                            );
                                        }
                                        if (result.newEval)
                                            finalEval = result.newEval;
                                        confirmedMultiPv =
                                            result.multiPvResult;
                                        if (result.afterEval) {
                                            finalPlayedEval = result.afterEval;
                                        }
                                        if (result.loss) {
                                            verifiedResponseLoss = result.loss;
                                            verifiedSwing =
                                                result.loss.cp ??
                                                verifiedSwing;
                                        }
                                        const confirmedBeforeScore =
                                            result.beforeEval
                                                ? engineScoreToWhitePov(
                                                      result.beforeEval.score,
                                                      userColor
                                                  )
                                                : null;
                                        const confirmedAfterScore =
                                            userResponseCompletesThreefold
                                                ? ({
                                                      kind: 'tablebase',
                                                      wdl: 'DRAW',
                                                      pov: 'WHITE',
                                                  } satisfies PovScore)
                                                : result.afterEval
                                                ? engineScoreToWhitePov(
                                                      result.afterEval.score,
                                                      otherSide(userColor)
                                                  )
                                                : null;
                                        if (
                                            confirmedBeforeScore &&
                                            confirmedAfterScore
                                        ) {
                                            responseScoreBefore =
                                                confirmedBeforeScore;
                                            responseScoreAfter =
                                                confirmedAfterScore;
                                        }
                                    }

                                    if (confirmed) {
                                        const tagsAndSeverity =
                                            tagsForCandidate({
                                                fenBefore: fenAfter,
                                                fenAfter:
                                                    userResponseMv.after,
                                                moverColor: userColor,
                                                bestAtBefore: finalEval,
                                                bestAtAfter:
                                                    finalPlayedEval,
                                                swingCp: verifiedSwing,
                                            });
                                        const tags = new Set<string>(
                                            tagsAndSeverity.tags
                                        );
                                        if (hasTacticalTheme)
                                            tags.add('tactical');

                                        let acceptedMovesUci:
                                            | string[]
                                            | undefined = undefined;
                                        let evaluatedLines: MultiPvLine[] =
                                            confirmedMultiPv?.lines ?? [];
                                        let acceptanceFrontier:
                                            | AcceptanceFrontier
                                            | undefined;
                                        let acceptedMovesError = false;
                                        try {
                                            const acceptedRes =
                                                await computeAcceptedMovesForPosition(
                                                    {
                                                        engine: args.engine,
                                                        fen: fenAfter,
                                                        limit: confirmedMultiPv
                                                            ? analysisLimit(
                                                                  opts,
                                                                  true,
                                                                  args.signal
                                                              )
                                                            : analysisLimit(
                                                                  opts,
                                                                  false,
                                                                  args.signal
                                                              ),
                                                        multiPv: opts.multiPv,
                                                        acceptableLossCp:
                                                            opts.fallbackMaxAcceptedCpLoss,
                                                        acceptableWinningChanceLoss:
                                                            opts.maxAcceptedWinningChanceLoss,
                                                        maxAcceptedMoves:
                                                            opts.maxAcceptedMoves,
                                                        bestMoveUci:
                                                            finalEval.bestMoveUci,
                                                        precomputed:
                                                            confirmedMultiPv,
                                                        previousFens:
                                                            userResponsePreviousFens,
                                                        gradingPolicy:
                                                            opts.gradingPolicy,
                                                    }
                                                );
                                            acceptedMovesUci =
                                                acceptedRes.acceptedMovesUci;
                                            evaluatedLines =
                                                acceptedRes.evaluatedLines;
                                            acceptanceFrontier =
                                                acceptedRes.acceptanceFrontier;
                                        } catch {
                                            // Ignore MultiPV failures; fall back to single-solution.
                                            acceptedMovesError = true;
                                        }

                                        const acceptedNormalized =
                                            acceptedMovesError
                                                ? normalizeUciList(
                                                      finalEval.bestMoveUci,
                                                      [],
                                                      1
                                                  )
                                                : normalizeUciList(
                                                      finalEval.bestMoveUci,
                                                      acceptedMovesUci,
                                                      opts.maxAcceptedMoves
                                                  );
                                        const isMulti =
                                            acceptedNormalized.length > 1;
                                        if (isMulti) tags.add('multiSolution');
                                        else tags.delete('multiSolution');
                                        if (acceptedMovesError)
                                            tags.add('acceptedMovesMissing');

                                        if (
                                            !responseScoreBefore ||
                                            !responseScoreAfter
                                        ) {
                                            decisionReceipts.set(
                                                nextPly,
                                                decisionReceipt({
                                                    ply: nextPly,
                                                    reason:
                                                        'ANALYSIS_INCOMPLETE',
                                                    loss: verifiedResponseLoss,
                                                    confirmation:
                                                        confirmationEvidence,
                                                })
                                            );
                                            continue;
                                        }
                                        const responseBeforeCpMover =
                                            scoreToCp(finalEval.score) ?? 0;
                                        const responseAfterCpMover =
                                            -(scoreToCp(
                                                finalPlayedEval.score
                                            ) ?? 0);
                                        const responseLessonKind: TrainingLessonKind =
                                            Math.abs(responseBeforeCpMover) <=
                                                DRAWISH_POSITION_ABS_CP &&
                                            responseAfterCpMover <
                                                CLEARLY_WORSE_POSITION_CP
                                                ? 'SAVE_DRAW'
                                                : verifiedSwing <
                                                        BIG_MISTAKE_CLASSIFICATION_CP &&
                                                    responseBeforeCpMover >=
                                                        PRESERVE_WIN_MIN_POSITION_CP &&
                                                    verifiedSwing >=
                                                        PRESERVE_WIN_MIN_LOSS_CP
                                                  ? 'PRESERVE_WIN'
                                                  : 'AVOID_MISTAKE';
                                        const builtMoment =
                                            await buildTrainingMoment({
                                                game,
                                                canonicalSourceGameId:
                                                    canonicalSourceGameIdValue,
                                                sourcePgnHash:
                                                    gameSourcePgnHash,
                                                decisionPly: nextPly,
                                                fen: fenAfter,
                                                originalMoveUci:
                                                    userResponseUci,
                                                originalScoreBefore:
                                                    responseScoreBefore,
                                                originalScoreAfter:
                                                    responseScoreAfter,
                                                originalLoss:
                                                    verifiedResponseLoss,
                                                sourceKind: 'MY_MISTAKE',
                                                lessonKind:
                                                    responseLessonKind,
                                                themes: Array.from(tags),
                                                solutionEval: finalEval,
                                                acceptedMovesUci:
                                                    acceptedNormalized,
                                                evaluatedLines,
                                                acceptanceFrontier,
                                                engine: args.engine,
                                                tablebase: args.tablebase,
                                                opts,
                                                configHash,
                                                previousFens:
                                                    userResponsePreviousFens,
                                                verificationCache,
                                                signal: args.signal,
                                            });
                                        const moment: TrainingMomentCandidate = {
                                            ...builtMoment,
                                            sourceKinds:
                                                orderedMetadataUnion(
                                                    builtMoment.sourceKinds,
                                                    [
                                                        'MISSED_OPPORTUNITY',
                                                    ],
                                                    SOURCE_KIND_ORDER
                                                ),
                                            lessonKinds:
                                                orderedMetadataUnion(
                                                    builtMoment.lessonKinds,
                                                    ['PUNISH_MISTAKE'],
                                                    LESSON_KIND_ORDER
                                                ),
                                        };
                                        storeCanonicalTrainingMoment(
                                            moments,
                                            moment
                                        );
                                        if (
                                            args.stopAfterFirstVerified &&
                                            isLandingReadyTrainingMoment(moment)
                                        ) {
                                            return {
                                                moments: [moment],
                                                manifests: [],
                                                configSnapshot,
                                                configHash,
                                                analysis: opts.returnAnalysis
                                                    ? analysisMap
                                                    : undefined,
                                            };
                                        }
                                        decisionReceipts.set(
                                            nextPly,
                                            decisionReceipt({
                                                ply: nextPly,
                                                reason:
                                                    moment.solution.trainable
                                                        ? 'SAVED'
                                                        : 'VERIFICATION_UNSTABLE',
                                                loss: verifiedResponseLoss,
                                                confirmation:
                                                    confirmationEvidence,
                                            })
                                        );
                                    } else {
                                        decisionReceipts.set(
                                            nextPly,
                                            decisionReceipt({
                                                ply: nextPly,
                                                reason:
                                                    confirmationEvidence?.termination ===
                                                        'MAX_BUDGET_UNSTABLE' ||
                                                    confirmationEvidence?.termination ===
                                                        'INCOMPLETE'
                                                        ? 'VERIFICATION_UNSTABLE'
                                                        : 'BELOW_THRESHOLD_AFTER_CONFIRMATION',
                                                loss: verifiedResponseLoss,
                                                confirmation:
                                                    confirmationEvidence,
                                            })
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        const scannedPlies = replay.history().length;
        const replayComplete = scannedPlies === plyCount;
        const extractionComplete =
            replayComplete && extractionErrors.length === 0;
        manifests.push({
            version: 1,
            complete: extractionComplete,
            sourceGameId: canonicalSourceGameIdValue,
            sourcePgnHash: gameSourcePgnHash,
            scannedPlies,
            expectedPlies: plyCount,
            termination: extractionComplete
                ? 'COMPLETED'
                : replayComplete
                  ? 'ANALYSIS_INCOMPLETE'
                  : 'SOURCE_REPLAY_STOPPED',
            errors: [
                ...extractionErrors,
                ...(!replayComplete
                    ? [
                          `Source replay stopped after ${scannedPlies}/${plyCount} plies`,
                      ]
                    : []),
            ],
        });

        // Store game analysis if requested
        if (opts.returnAnalysis && gameAnalysis.length > 0) {
            // Rebuild markers from canonical user decisions. This removes the
            // historical adjacent-marker artifact where a missed opportunity
            // was attached to the opponent's blunder and the same decision was
            // also attached to the user's following move.
            for (const move of gameAnalysis) {
                delete move.hasTrainingMoment;
                delete move.trainingMomentSource;
            }
            for (const moment of moments) {
                if (moment.sourceGameId !== canonicalSourceGameIdValue)
                    continue;
                if (!moment.solution.trainable) continue;
                const move = gameAnalysis.find(
                    (candidate) => candidate.ply === moment.decisionPly
                );
                if (!move) continue;
                move.hasTrainingMoment = true;
                move.trainingMomentSource = moment.sourceKinds.includes(
                    'MY_MISTAKE'
                )
                    ? 'MY_MISTAKE'
                    : 'MISSED_OPPORTUNITY';
            }

            const round1 = (n: number) => Math.round(n * 10) / 10;
            const whiteAccuracy = lichessGameAccuracy({
                moveAccuracies: whiteMoveAccuracies,
            });
            const blackAccuracy = lichessGameAccuracy({
                moveAccuracies: blackMoveAccuracies,
            });

            const gameMoments = moments.filter(
                (moment) =>
                    moment.sourceGameId === canonicalSourceGameIdValue
            );
            for (const moment of gameMoments) {
                const previous = decisionReceipts.get(
                    moment.decisionPly
                );
                const trainable = moment.solution.trainable;
                decisionReceipts.set(moment.decisionPly, {
                    ...decisionReceipt({
                        ply: moment.decisionPly,
                        reason: trainable
                            ? 'SAVED'
                            : 'VERIFICATION_UNSTABLE',
                        loss: {
                            cp: moment.originalDecision.cpLoss ?? null,
                            winningChance:
                                moment.originalDecision.winChanceLoss ??
                                null,
                        },
                        confirmation: previous?.confirmation,
                    }),
                    verificationStatus:
                        moment.solution.verificationStatus,
                    sourceKinds: moment.sourceKinds,
                });
            }
            const receiptDecisions = Array.from(
                decisionReceipts.values()
            ).sort((left, right) => left.ply - right.ply);
            const reasonCounts = emptyExtractionReasonCounts();
            for (const receipt of receiptDecisions) {
                reasonCounts[receipt.reason] += 1;
            }
            const trainingExtraction: TrainingExtractionReceipt = {
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
                    userDecisions: receiptDecisions.length,
                    savedPositions: receiptDecisions.filter(
                        (receipt) => receipt.status === 'SAVED'
                    ).length,
                    unresolvedDecisions: receiptDecisions.filter(
                        (receipt) => receipt.status === 'UNRESOLVED'
                    ).length,
                    reasons: reasonCounts,
                },
                decisions: receiptDecisions,
            };

            analysisMap.set(game.id, {
                gameId: game.id,
                moves: gameAnalysis,
                whiteAccuracy:
                    typeof whiteAccuracy === 'number'
                        ? round1(whiteAccuracy)
                        : undefined,
                blackAccuracy:
                    typeof blackAccuracy === 'number'
                        ? round1(blackAccuracy)
                        : undefined,
                trainingExtraction,
                analyzedAt: new Date().toISOString(),
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
