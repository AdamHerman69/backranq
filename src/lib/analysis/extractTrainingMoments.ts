import { replayT2Game, runT2Game, type T2StrategyState } from './t2Strategy';
import { T2_BUDGETS, T2_SELECTION_POLICY_ID, CORROBORATED_SELECTION_POLICY_ID, type SelectionPolicyId, type T2PointDecision } from './t2Policy';
import type { T2SelectionInput } from '@/lib/training/selectionPolicy';
import { emptyExtractionWork, extractionWorkSince, type ExtractionWork } from './extractionWork';
import { assessPracticeReferenceReadiness } from '@/lib/training/assessmentPolicy';
import { assessPracticeExactPosition } from './practiceExactEvidence';
import { pieceCountFromFen, TABLEBASE_MAX_PIECES } from './tablebase';
import { supplementPracticeCoverage } from './practiceCoverage';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import { Chess, type Move } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import type {
    EvalResult,
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
import type { TablebaseProvider } from '@/lib/analysis/tablebase';
import type {
    PovScore,
    TrainingLessonKind,
    TrainingMomentCandidate,
    TrainingSourceKind,
} from '@/lib/training/contracts';
import {
    isTrainableSolution,
} from '@/lib/training/contracts';
import { sha256Hex } from '@/lib/crypto/sha256';
import { normalizeGradingPolicy } from '@/lib/training/config';
import { PositionAnalysisPool, type PositionAnalysisPoolState } from './positionAnalysisPool';
import { assessPracticePosition, buildPracticeMomentRevision } from './practiceMomentBuilder';
import { practiceContextId, type AssessmentPolicy, type DecisionAssessment } from '@/lib/training/practiceContract';
import {
    appendAssessmentHistory,
    MAX_ASSESSMENT_POSITION_HISTORY,
} from '@/lib/training/assessmentIdentity';
import {
    ruleTerminalEvaluation,
} from '@/lib/analysis/ruleEvaluation';
import { createExtractionConfigSnapshot } from '@/lib/analysis/extractionConfig';
import {
    emptyExtractionReasonCounts,
    type AdaptiveConfirmationEvidence,
    type TrainingDecisionReceipt,
} from '@/lib/analysis/extractionReceipt';

type MistakeSeverity = 'small' | 'medium' | 'big';

export type TrainingMomentExtractionOptions = {
    selectionPolicyId?: SelectionPolicyId;
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
    gradingPolicy?: AssessmentPolicy;
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

    /** Initial confirmation alternatives; missing answers remain explicitly pending. */
    multiPv?: number;

    /**
     * If true, also return move-by-move analysis with classifications for each game.
     * This captures eval data for all analyzed moves, not just training moments.
     * Defaults to false.
     */
    returnAnalysis?: boolean;
};

export function isLandingReadyTrainingMoment(moment: TrainingMomentCandidate): boolean {
    return isTrainableSolution(moment.solution)
        && moment.solution.manifest.assessments.some(a => a.quality === 'GOOD' && a.qualitySupport === 'SUPPORTED');
}

/** Selection strategy is independent of engine/runtime and compute budgets. */
export type TrainingMomentExtractionStrategy = 'FULL_GAME' | 'FIRST_PUZZLE';

/** Canonical replay state; presentation must never reconstruct a second PGN. */
export type TrainingMomentExtractionProgress = {
    runId: string;
    gameId: string;
    gameIndex: number;
    gameCount: number;
    ply: number;
    plyCount: number;
    phase: 'scanning' | 'confirming';
    fen: string;
    previousFen?: string;
    positionHistory: string[];
    userSide: 'white' | 'black';
};

/**
 * Authoritative training-moment extraction result.
 */
export type TrainingMomentExtractionResult = {
    /** Cumulative physical work, including discarded candidates and prior checkpoint slices. */
    engineWork: ExtractionWork;
    /** Feed candidates plus canonical revisions of explicitly reassessed decisions. */
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
    t2State?: T2StrategyState;
    version: 2;
    gameId: string;
    sourceGameId: string;
    sourcePgnHash: string;
    configHash: string;
    nextPly: number;
    expectedPlies: number;
    /** Frozen targeting hints; only canonical new evidence can change training state. */
    reassessDecisionPlies: number[];
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
    analysisPool: PositionAnalysisPoolState;
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
    selectionPolicyId: SelectionPolicyId;
    movetimeMs: number;
    nodesPerPosition: number | null;
    maxDepth: number | null;
    engineTimeoutMs: number;
    minWinningChanceLoss: number;
    fallbackMinCpLoss: number;
    gradingPolicy: AssessmentPolicy;
    themeLookaheadPlies: number;
    confirmMovetimeMs: number | null;
    confirmNodes: number | null;
    maxConfirmationNodes: number | null;
    returnAnalysis: boolean;
    multiPv: number;

};

export function resolveTrainingMomentExtractionOptions(
    options?: TrainingMomentExtractionOptions,
): ResolvedOptions {
    const selectionPolicyId = options?.selectionPolicyId ?? T2_SELECTION_POLICY_ID;
    if (![T2_SELECTION_POLICY_ID, CORROBORATED_SELECTION_POLICY_ID].includes(selectionPolicyId)) throw new Error('Unknown extraction selection policy');
    if (selectionPolicyId === T2_SELECTION_POLICY_ID) {
        return { selectionPolicyId, movetimeMs: 200, nodesPerPosition: T2_BUDGETS.scanNodes, maxDepth: null,
            engineTimeoutMs: Math.max(1_000, options?.engineTimeoutMs ?? 30_000), minWinningChanceLoss: .03, fallbackMinCpLoss: 30,
            gradingPolicy: normalizeGradingPolicy(options?.gradingPolicy, 'PRACTICAL', selectionPolicyId),
            themeLookaheadPlies: options?.themeLookaheadPlies ?? 4, confirmMovetimeMs: null, confirmNodes: T2_BUDGETS.confirmationNodes,
            maxConfirmationNodes: T2_BUDGETS.candidateNodes, multiPv: T2_BUDGETS.rootMultiPv, returnAnalysis: options?.returnAnalysis ?? false };
    }
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
    return {
        selectionPolicyId,
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
        gradingPolicy: normalizeGradingPolicy(options?.gradingPolicy, 'PRACTICAL', selectionPolicyId),
        themeLookaheadPlies: options?.themeLookaheadPlies ?? 4,
        confirmMovetimeMs: options?.confirmMovetimeMs ?? null,
        confirmNodes,
        maxConfirmationNodes,
        returnAnalysis: options?.returnAnalysis ?? false,
        multiPv,

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
    exactRoot?: ReturnType<typeof assessPracticeExactPosition>;
    confirmed: boolean;
    newEval?: EvalResult;
    beforeEval?: EvalResult;
    afterEval?: EvalResult;
    loss?: ReturnType<typeof evaluationLoss>;
    multiPvResult?: MultiPvResult;
    confirmedLossCp?: number;
    confirmedWinningChanceLoss?: number;
    decision?: DecisionAssessment;
};

async function confirmCandidate(args: {
    engine: StockfishEngine; pool: PositionAnalysisPool;
    beforeFen: string; afterFen: string; solutionFen: string;
    minimumWinningChanceLoss: number; fallbackMinimumLossCp: number;
    gradingPolicy: AssessmentPolicy; multiPv: number;
    limit: ReturnType<typeof analysisLimit>; previousFens?: string[];
    minimumConfirmationNodes: number; nodeBudgets?: readonly number[];
}): Promise<ConfirmationCandidateResult & { confirmationEvidence?: AdaptiveConfirmationEvidence }> {
    const root = new Chess(args.solutionFen);
    const original = root.moves({ verbose: true }).find(move => move.after === args.afterFen);
    if (!original || args.beforeFen !== args.solutionFen) return { confirmed: false };
    const moveUci = `${original.from}${original.to}${original.promotion ?? ''}`;
    const previousFens = args.previousFens ?? [];
    const positionArgs = { pool: args.pool, fen: args.solutionFen, positionHistory: previousFens,
        trainingSide: root.turn() === 'w' ? 'WHITE' as const : 'BLACK' as const,
        originalMoveUci: moveUci, policy: args.gradingPolicy, minimumConfirmationNodes: args.minimumConfirmationNodes };
    const nodeBudgets = args.nodeBudgets ?? (args.limit.nodes == null ? [] : [args.limit.nodes]);
    const stages: readonly (number | null)[] = nodeBudgets.length ? nodeBudgets : [null];
    // Preserve the previous implicit ceiling of at most a root and original search per profile level.
    let remainingNodes = nodeBudgets.length ? 2 * nodeBudgets.reduce((sum, nodes) => sum + nodes, 0) : null;
    const maxNodes = nodeBudgets.at(-1) ?? null;
    const deadline = performance.now() + 2 * stages.length * args.limit.timeoutMs;
    const passes: AdaptiveConfirmationEvidence['passes'] = [];
    let rootCursor = 0; let originalCursor = 0; let dispatched = 0;
    const probedPremises = new Set<string>();
    let assessment = assessPracticePosition(positionArgs);
    const rootSearch = () => args.pool.find({ fen: args.solutionFen, previousFens })
        .findLast(search => search.result && search.evidence.request.rootMoves.length === root.moves().length
            && search.snapshots.some(snapshot => snapshot.bundleComplete));
    let multiPvResult = rootSearch()?.result ?? undefined;
    const project = (): ConfirmationCandidateResult => {
        const solutionEval = multiPvResult && evalFromMultiPv(args.solutionFen, multiPvResult);
        if (!solutionEval || !hasUsablePv(solutionEval)) return { confirmed: false, multiPvResult, decision: assessment?.decision };
        const originalSearch = args.pool.find({ fen: args.solutionFen, previousFens, moveUci })
            .findLast(search => search.result?.lines.some(line => line.pvUci[0] === moveUci));
        const originalLine = originalSearch?.result?.lines.find(line => line.pvUci[0] === moveUci);
        if (!originalLine?.score) return { confirmed: false, newEval: solutionEval, multiPvResult, decision: assessment?.decision };
        const afterEval: EvalResult = { fen: args.afterFen, bestMoveUci: originalLine.pvUci[1] ?? '',
            pvUci: originalLine.pvUci.slice(1), score: negateScore(originalLine.score),
            wdl: reverseWdl(originalLine.wdl), searchEvidence: originalSearch?.evidence };
        const loss = evaluationLoss({ score: solutionEval.score, wdl: solutionEval.wdl },
            { score: originalLine.score, wdl: originalLine.wdl });
        return { confirmed: assessment?.decision.status === 'CONFIRMED_MISTAKE', decision: assessment?.decision,
            newEval: solutionEval, beforeEval: solutionEval, afterEval, loss, multiPvResult,
            confirmedLossCp: loss.cp ?? undefined, confirmedWinningChanceLoss: loss.winningChance ?? undefined };
    };
    const referenceReadiness = () => assessment && assessPracticeReferenceReadiness({ evidence: assessment.evidence,
        frame: assessment.frame, trainingSide: positionArgs.trainingSide,
        referenceMoveUci: assessment.rootAnswerIndex.preferredMoveUci, policy: args.gradingPolicy });
    let readiness = referenceReadiness();
    while (performance.now() < deadline && (nodeBudgets.length > 0 || dispatched < 2)) {
        if (args.limit.signal?.aborted) throw new Error('Analysis aborted');
        const paidRoot = rootSearch();
        const paidRootNodes = paidRoot?.evidence.request.limits.nodes ?? paidRoot?.evidence.reported.nodes ?? 0;
        const rootBudgetSatisfied = paidRootNodes >= args.minimumConfirmationNodes;
        if (readiness?.status === 'READY' && rootBudgetSatisfied && assessment?.decision.status !== 'UNRESOLVED') break;
        let nodes: number | null;
        let purpose: 'MISSING_REFERENCE' | 'REFERENCE_DRIFT' | 'VERIFY_REFERENCE' | 'MISSING_MOVE';
        let rootMoves: string[] | undefined;
        if (!rootBudgetSatisfied || !readiness || readiness.requiredWork === 'ROOT') {
            // Missing verification is not a reason to discard a perfectly usable paid full-root choice.
            while (rootCursor < stages.length && stages[rootCursor] != null && stages[rootCursor]! <= paidRootNodes) rootCursor++;
            if (rootCursor >= stages.length) break;
            nodes = stages[rootCursor++];
            purpose = readiness?.status === 'REFERENCE_VALUE_DRIFT' || readiness?.status === 'UNRESOLVED_REFERENCE'
                ? 'REFERENCE_DRIFT' : 'MISSING_REFERENCE';
        } else if (readiness.requiredWork === 'REFERENCE_PROBE') {
            // Explicit depth/time profiles keep their original limit. Actual
            // observed work still has to satisfy the shared 400k proof floor.
            nodes = maxNodes == null ? null : args.gradingPolicy.minimumReferenceProbeNodes;
            if (nodes != null && nodes > maxNodes!) break;
            const premise = `${readiness.rootSearchId}:${readiness.preferredMoveUci}`;
            // An incomplete/immature probe is unresolved; never spin on an identical missing fact.
            if (probedPremises.has(premise)) break;
            probedPremises.add(premise);
            purpose = 'VERIFY_REFERENCE'; rootMoves = [readiness.preferredMoveUci];
        } else {
            if (readiness.status !== 'READY' || originalCursor >= stages.length) break;
            nodes = stages[originalCursor++];
            purpose = 'MISSING_MOVE'; rootMoves = [moveUci];
        }
        if (nodes != null && remainingNodes != null && nodes > remainingNodes) break;
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs < 1) break;
        if (nodes != null && remainingNodes != null) remainingNodes -= nodes;
        dispatched++;
        const limit = { ...args.limit, ...(nodes == null ? {} : { nodes }), timeoutMs: Math.min(args.limit.timeoutMs, remainingMs) };
        let result: EvalResult | MultiPvResult;
        try {
            result = rootMoves
                ? await args.engine.evalPosition({ fen: args.solutionFen, ...limit, rootMoves,
                    previousFens, reuse: 'FRESH_REQUIRED', purpose })
                : await args.engine.analyzeMultiPv({ fen: args.solutionFen, ...limit, multiPv: args.multiPv,
                    previousFens, reuse: 'FRESH_REQUIRED', purpose });
        } catch (error) {
            if (args.limit.signal?.aborted) throw error;
            if (performance.now() >= deadline) break;
            throw error;
        }
        if (args.limit.signal?.aborted) throw new Error('Analysis aborted');
        assessment = assessPracticePosition(positionArgs);
        multiPvResult = rootSearch()?.result ?? undefined;
        const current = project();
        readiness = referenceReadiness();
        const referenceReady = readiness?.status === 'READY';
        if (nodes != null) passes.push({ nodes, purpose, searchId: result.searchEvidence?.id ?? null,
            outcome: result.searchEvidence ? 'RETURNED' : 'UNATTRIBUTED',
            bestMoveUci: current.newEval?.bestMoveUci ?? null, qualifies: current.confirmed,
            cpLoss: referenceReady ? current.loss?.cp ?? null : null, winChanceLoss: referenceReady ? current.loss?.winningChance ?? null : null });
    }
    const latest = project();
    const stable = latest.decision != null && latest.decision.status !== 'UNRESOLVED';
    return { ...latest, ...(args.nodeBudgets ? { confirmationEvidence: { version: 2 as const, stable,
        termination: stable ? latest.confirmed ? 'STABLE' as const : 'BELOW_THRESHOLD' as const
            : latest.newEval ? 'MAX_BUDGET_UNSTABLE' as const : 'INCOMPLETE' as const, passes } } : {}) };
}

function confirmationBudgets(baseNodes: number, maxNodes: number): number[] {
    const budgets = [Math.max(1, Math.trunc(baseNodes))];
    while (budgets.at(-1)! < maxNodes) budgets.push(Math.min(maxNodes, budgets.at(-1)! * 2));
    return budgets;
}

async function confirmCandidateAdaptively(args: {
    engine: StockfishEngine; pool: PositionAnalysisPool; beforeFen: string; afterFen: string; solutionFen: string;
    minimumWinningChanceLoss: number; fallbackMinimumLossCp: number; gradingPolicy: AssessmentPolicy;
    multiPv: number; baseNodes: number; maxNodes: number; timeoutMs: number; previousFens?: string[];
    signal?: AbortSignal;
}): Promise<ConfirmationCandidateResult & { confirmationEvidence: AdaptiveConfirmationEvidence }> {
    const result = await confirmCandidate({ ...args, minimumConfirmationNodes: args.baseNodes,
        nodeBudgets: confirmationBudgets(args.baseNodes, args.maxNodes),
        limit: { nodes: args.baseNodes, timeoutMs: args.timeoutMs, signal: args.signal } });
    return { ...result, confirmationEvidence: result.confirmationEvidence ?? {
        version: 2, stable: false, termination: 'INCOMPLETE', passes: [] } };
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
    const preferred = candidate.solution.manifest.assessments.length >= existing.solution.manifest.assessments.length
        ? candidate : existing;
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
    game: NormalizedGame; canonicalSourceGameId: string; sourcePgnHash: string; decisionPly: number;
    fen: string; originalMoveUci: string; originalScoreBefore: PovScore; originalScoreAfter: PovScore;
    originalLoss: ReturnType<typeof evaluationLoss>; sourceKind: TrainingSourceKind;
    lessonKind: TrainingLessonKind; themes: string[]; pool: PositionAnalysisPool;
    opts: ResolvedOptions; configHash: string; previousFens: string[];
    exactRoot?: ReturnType<typeof assessPracticeExactPosition>;
    selectionInput?: T2SelectionInput;
}): Promise<TrainingMomentCandidate> {
    const side = sideToMoveFromFen(args.fen);
    const trainingSide = side === 'w' ? 'WHITE' as const : 'BLACK' as const;
    const manifest = await buildPracticeMomentRevision({ pool: args.pool,
        source: { gameId: args.canonicalSourceGameId, sourcePgnHash: args.sourcePgnHash,
            decisionPly: args.decisionPly, contextId: practiceContextId(args.fen, args.previousFens, trainingSide),
            fen: args.fen, positionHistory: args.previousFens, trainingSide, originalMoveUci: args.originalMoveUci },
        executionProfileId: args.configHash, minimumConfirmationNodes: args.opts.confirmNodes ?? 1,
        policy: args.opts.gradingPolicy, exactRoot: args.exactRoot, selectionInput: args.selectionInput, selectionPolicyId: args.opts.selectionPolicyId });
    if (!manifest) throw new Error('Confirmed decision lost its reference evidence');
    return { sourceGameId: args.canonicalSourceGameId, sourceProvider: args.game.provider,
        sourcePlayedAt: args.game.playedAt, sourcePgnHash: args.sourcePgnHash, decisionPly: args.decisionPly,
        fen: args.fen, positionHistory: args.previousFens, sideToMove: side, originalMoveUci: args.originalMoveUci,
        sourceKinds: [args.sourceKind], lessonKinds: [args.lessonKind], themes: [...new Set(args.themes)].sort(),
        originalDecision: originalDecisionForPracticeManifest(manifest),
        phase: phaseFromPosition({ fen: args.fen, ply: args.decisionPly }).toUpperCase() as 'OPENING' | 'MIDDLEGAME' | 'ENDGAME',
        solution: { manifest, configHash: args.configHash } };
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
    /** Existing decisions to confirm even when the broad scan no longer selects them. */
    reassessDecisionPliesByGameId?:
        ReadonlyMap<string, readonly number[]> | Readonly<Record<string, readonly number[]>>;
    onProgress?: (progress: TrainingMomentExtractionProgress) => void;
    strategy?: TrainingMomentExtractionStrategy;
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
}): Promise<TrainingMomentExtractionResult> {
    if (args.signal?.aborted) throw new Error('Analysis aborted');
    const strategy = args.strategy ?? 'FULL_GAME';
    const firstPuzzle = strategy === 'FIRST_PUZZLE';
    const selected = args.games.filter((game) =>
        args.selectedGameIds.has(game.id),
    );
    if (firstPuzzle)
        selected.sort((left, right) =>
            new Date(right.playedAt).getTime() - new Date(left.playedAt).getTime(),
        );
    const runId = crypto.randomUUID();
    if ((args.checkpoint || args.shouldYield) && selected.length !== 1)
        throw new Error('Resumable extraction requires exactly one game');
    if (firstPuzzle && (args.checkpoint || args.shouldYield))
        throw new Error('FIRST_PUZZLE does not support full-game checkpoints');
    const poolLimits = { maxContexts: 4096, maxSearches: 8192 };
    const pool = args.checkpoint?.analysisPool
        ? PositionAnalysisPool.hydrate(args.checkpoint.analysisPool, poolLimits)
        : new PositionAnalysisPool(poolLimits);
    args = { ...args, engine: pool.wrap(args.engine) };
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
    for (const [gameIndex, game] of selected.entries()) {
        const gameWorkStart = args.checkpoint ? emptyExtractionWork() : pool.report();
        const sourceId = canonicalSourceGameId(
            args.canonicalSourceGameIdByGameId,
            game.id,
        );
        const pgnHash = await sourcePgnHash(game.pgn);
        const scope = firstPuzzle ? 'TARGETED_DECISION' : 'FULL_GAME';
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
                resume.sourceGameId !== sourceId ||
                resume.expectedPlies !== moves.length ||
                !Number.isInteger(resume.nextPly) ||
                resume.nextPly < 0 || resume.nextPly > moves.length)
        )
            throw new Error(
                'Analysis checkpoint does not match source or extraction',
            );
        const startPly = resume?.nextPly ?? 0;
        const targeting = args.reassessDecisionPliesByGameId;
        const requestedPlies = targeting && 'get' in targeting && typeof targeting.get === 'function'
            ? targeting.get(game.id) : (targeting as Readonly<Record<string, readonly number[]>> | undefined)?.[game.id];
        const reassessDecisionPlies = firstPuzzle ? [] : [...new Set(resume?.reassessDecisionPlies ?? requestedPlies ?? [])].sort((a, b) => a - b);
        if (reassessDecisionPlies.some(ply => !Number.isInteger(ply) || ply < 0 || ply >= moves.length))
            throw new Error('Reassessment decision does not belong to the source game');
        const reassessed = new Set(reassessDecisionPlies);
        if (opts.selectionPolicyId === T2_SELECTION_POLICY_ID) {
            let replay: ReturnType<typeof replayT2Game>;
            try { replay = replayT2Game(game); }
            catch (error) {
                manifests.push(manifest('INVALID_SOURCE', moves.length, 0, [error instanceof Error ? error.message : 'Invalid source'], []));
                continue;
            }
            if (moves.length > MAX_ASSESSMENT_POSITION_HISTORY) {
                manifests.push(manifest('INVALID_SOURCE', moves.length, 0, ['Source exceeds supported canonical history'], []));
                continue;
            }
            if (resume && !resume.t2State) throw new Error('T2 checkpoint is missing strategy state');
            const outcomeByPly = new Map<number, ExtractionCompletionManifest['decisionOutcomes'][number]>();
            const builtByPly = new Map<number, TrainingMomentCandidate>();
            const finishDecision = async (decision: T2PointDecision) => {
                args.signal?.throwIfAborted();
                const ply = decision.ply;
                if (!decision.preferredMoveUci || !decision.referenceScore || !decision.originalScore
                    || (!decision.admitted && !reassessed.has(ply))) return false;
                const fen = replay.positions[ply]; const previousFens = replay.positions.slice(0, ply);
                const comparison = decision.comparisonBasis;
                const rootSearch = pool.find({ fen, previousFens }).find(s => s.evidence.id === decision.evidenceIds[0]);
                const rootLine = rootSearch?.result?.lines.find(l => l.pvUci[0] === decision.preferredMoveUci);
                const childFen = replay.positions[ply + 1];
                const childSearch = pool.find({ fen: childFen, previousFens: replay.positions.slice(0, ply + 1) })
                    .find(s => s.evidence.request.purpose === 'T2_SCAN');
                const childLine = childSearch?.result?.lines.find(l => l.multipv === 1);
                const beforeEval: EvalResult = { fen, bestMoveUci: decision.preferredMoveUci,
                    pvUci: rootLine?.pvUci ?? [decision.preferredMoveUci], score: decision.referenceScore, wdl: decision.referenceWdl };
                const afterEval: EvalResult = { fen: childFen, bestMoveUci: childLine?.pvUci[0] ?? '',
                    pvUci: childLine?.pvUci ?? [], score: childLine?.score ?? null, wdl: childLine?.wdl };
                const moment = await buildTrainingMoment({ game, canonicalSourceGameId: sourceId, sourcePgnHash: pgnHash,
                    decisionPly: ply, fen, originalMoveUci: decision.originalMoveUci,
                    originalScoreBefore: engineScoreToWhitePov(decision.referenceScore, userColor)!,
                    originalScoreAfter: engineScoreToWhitePov(decision.originalScore, userColor)!,
                    originalLoss: evaluationLoss({ score: decision.referenceScore, wdl: decision.referenceWdl }, { score: decision.originalScore, wdl: decision.originalWdl }),
                    sourceKind: 'MY_MISTAKE', lessonKind: Math.abs(scoreToCp(decision.referenceScore) ?? Infinity) <= 100
                        && (scoreToCp(decision.originalScore) ?? 0) < -100 ? 'SAVE_DRAW' : 'AVOID_MISTAKE',
                    themes: tagsForCandidate({ fenBefore: fen, fenAfter: childFen, moverColor: userColor,
                        bestAtBefore: beforeEval, bestAtAfter: afterEval, swingCp: decision.lossCp ?? 0 }).tags, pool, opts, configHash, previousFens,
                    selectionInput: { policyId: T2_SELECTION_POLICY_ID, referenceSearchId: decision.evidenceIds[0],
                        originalSearchId: decision.evidenceIds[1], comparisonBasis: comparison,
                        preferredMoveUci: decision.preferredMoveUci } });
                args.signal?.throwIfAborted();
                if (ply > 0) {
                    const opponent = pool.find({ fen: replay.positions[ply - 1], previousFens: replay.positions.slice(0, ply - 1) })
                        .find(s => s.evidence.request.purpose === 'T2_SCAN')?.result?.lines[0];
                    const currentScan = pool.find({ fen, previousFens }).find(s => s.evidence.request.purpose === 'T2_SCAN')?.result?.lines[0];
                    if (opponent && currentScan) {
                        const opponentLoss = evaluationLoss({ score: opponent.score, wdl: opponent.wdl },
                            { score: negateScore(currentScan.score), wdl: currentScan.wdl ? reverseWdl(currentScan.wdl) : undefined });
                        if ((opponentLoss.cp ?? 0) >= opts.fallbackMinCpLoss || (opponentLoss.winningChance ?? 0) >= opts.minWinningChanceLoss) {
                            moment.sourceKinds.push('MISSED_OPPORTUNITY'); moment.lessonKinds.push('PUNISH_MISTAKE');
                        }
                    }
                }
                // The separately derived answer diagnostic may remain unresolved even for an included selection.
                outcomeByPly.set(ply, { decisionPly: ply, status: moment.solution.manifest.decision.status,
                    reason: moment.solution.manifest.decision.reason });
                builtByPly.set(ply, moment);
                if (isTrainableSolution(moment.solution) || reassessed.has(ply)) storeCanonicalTrainingMoment(moments, moment);
                return firstPuzzle && isLandingReadyTrainingMoment(moment);
            };
            const result = await runT2Game({ replay, engine: args.engine, pool, signal: args.signal, timeoutMs: opts.engineTimeoutMs, state: resume?.t2State,
                shouldYield: args.shouldYield, onProgress: (ply, phase) => args.onProgress?.({ runId, gameId: game.id,
                    gameIndex, gameCount: selected.length, ply, plyCount: moves.length, phase, fen: replay.positions[ply],
                    previousFen: replay.positions[ply - 1], positionHistory: replay.positions.slice(0, ply),
                    userSide: userColor === 'w' ? 'white' : 'black' }), onDecision: firstPuzzle ? finishDecision : undefined });
            if (result.yielded) {
                return { engineWork: pool.report(), moments, manifests, configSnapshot, configHash,
                    checkpoint: { version: 2, gameId: game.id, sourceGameId: sourceId, sourcePgnHash: pgnHash, configHash,
                        nextPly: result.state.phase === 'SCAN' ? Math.min(moves.length, result.state.nextScanIndex) : moves.length,
                        expectedPlies: moves.length, reassessDecisionPlies, moments, gameAnalysis: [], whiteMoveAccuracies: [],
                        blackMoveAccuracies: [], extractionErrors: [], decisionReceipts: [], analysisPool: pool.serialize(), t2State: result.state },
                    analysis: opts.returnAnalysis ? analysisMap : undefined };
            }
            if (!firstPuzzle) for (const decision of result.state.decisions) await finishDecision(decision);
            const finalDecisions = firstPuzzle && result.stopped
                ? result.state.decisions.filter(d => result.state.candidatePlies.slice(0, result.state.nextCandidateIndex).includes(d.ply))
                : result.state.decisions;
            const decisions: TrainingDecisionReceipt[] = finalDecisions.map(d => {
                const saved = builtByPly.get(d.ply)?.solution.manifest.selection.status === 'INCLUDED';
                const reason: TrainingDecisionReceipt['reason'] = saved ? 'MISTAKE_CONFIRMED'
                    : d.reason === 'FORCED_MOVE' ? 'FORCED_MOVE'
                    : d.estimate === 'GOOD' ? 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
                    : d.estimate === 'UNKNOWN' ? 'MISTAKE_COMPARISON_UNRESOLVED'
                    : d.candidate ? 'NO_MEANINGFUL_SELECTION_SIGNAL' : 'BELOW_CANDIDATE_SIGNAL';
                return { ply: d.ply, status: saved ? 'SAVED' : d.estimate === 'UNKNOWN' ? 'UNRESOLVED' : 'NOT_SAVED',
                    reason, cpLoss: d.lossCp !== null && d.lossCp >= 0 ? d.lossCp : null,
                    winChanceLoss: d.lossExpectedScore !== null && d.lossExpectedScore >= 0 ? d.lossExpectedScore : null, t2Decision: d };
            });
            const outcomes = finalDecisions.map(d => outcomeByPly.get(d.ply) ?? ({ decisionPly: d.ply,
                status: d.estimate === 'GOOD' || d.reason === 'FORCED_MOVE' ? 'NOT_A_MISTAKE' as const : 'UNRESOLVED' as const,
                reason: d.reason }));
            manifests.push(manifest('COMPLETED', moves.length, moves.length, [], outcomes));
            if (opts.returnAnalysis) {
                const scans = new Map(result.state.scanSearchIds);
                const paid = new Map(pool.serialize().searches.map(s => [s.evidence.id, s]));
                const scoreAt = (ply: number) => paid.get(scans.get(ply) ?? '')?.result?.lines.find(l => l.multipv === 1);
                const accuracies: Record<'w' | 'b', number[]> = { w: [], b: [] };
                const analyzed: AnalyzedMove[] = replay.moves.flatMap((move, ply): AnalyzedMove[] => {
                    const root = scoreAt(ply); const child = scoreAt(ply + 1);
                    const exact = ruleTerminalEvaluation(replay.positions[ply + 1], replay.positions.slice(0, ply + 1));
                    const before = root?.score ?? null; const after = child?.score ?? exact?.score ?? null;
                    // T2 scans only player decisions and their children. Missing opponent endpoints
                    // stay unanalysed rather than masquerading as zero-loss good moves.
                    if (!before || !after) return [];
                    const loss = evaluationLoss({ score: before }, { score: after ? negateScore(after) : null });
                    const beforeCp = scoreToCp(before); const afterCp = scoreToCp(after);
                    const accuracy = beforeCp !== null && afterCp !== null && new Chess(move.before).moves().length > 1
                        ? lichessMoveAccuracyFromCps({ beforeCp, afterCp: -afterCp }).accuracy : undefined;
                    if (accuracy !== undefined) accuracies[move.color].push(accuracy);
                    const saved = builtByPly.get(ply)?.solution.manifest.selection.status === 'INCLUDED';
                    return [{ ply, san: move.san, uci: `${move.from}${move.to}${move.promotion ?? ''}`, evalBefore: before, evalAfter: after, cpLoss: Math.max(0, loss.cp ?? 0),
                        classification: classifyMove({ cpLoss: Math.max(0, loss.cp ?? 0), isBestMove: root?.pvUci[0] === `${move.from}${move.to}${move.promotion ?? ''}`,
                            wasAlreadyLost: (beforeCp ?? 0) < -300 }), accuracy, bestMoveUci: root?.pvUci[0],
                        bestMoveSan: root ? uciToSan(move.before, root.pvUci[0]) ?? undefined : undefined,
                        hasTrainingMoment: saved, ...(saved ? { trainingMomentSource: 'MY_MISTAKE' as const } : {}) }];
                });
                const reasons = emptyExtractionReasonCounts();
                for (const d of decisions) reasons[d.reason]++;
                analysisMap.set(game.id, { gameId: game.id, moves: analyzed, analyzedAt: new Date().toISOString(),
                    whiteAccuracy: lichessGameAccuracy({ moveAccuracies: accuracies.w }) ?? undefined,
                    blackAccuracy: lichessGameAccuracy({ moveAccuracies: accuracies.b }) ?? undefined,
                    trainingExtraction: { version: 2, engineWork: extractionWorkSince(pool.report(), gameWorkStart),
                        trainingSide: userColor === 'w' ? 'WHITE' : 'BLACK',
                        thresholds: { minWinChanceLoss: opts.minWinningChanceLoss, fallbackMinCpLoss: opts.fallbackMinCpLoss },
                        budgets: { scanNodes: T2_BUDGETS.scanNodes, confirmationBaseNodes: T2_BUDGETS.confirmationNodes,
                            confirmationMaxNodes: T2_BUDGETS.candidateNodes, multiPvStart: T2_BUDGETS.rootMultiPv, multiPvMax: T2_BUDGETS.rootMultiPv },
                        summary: { userDecisions: decisions.length, savedPositions: decisions.filter(d => d.status === 'SAVED').length,
                            unresolvedDecisions: decisions.filter(d => d.status === 'UNRESOLVED').length, reasons }, decisions } });
            }
            if (firstPuzzle && result.stopped) return { engineWork: pool.report(), moments, manifests, configSnapshot, configHash,
                analysis: opts.returnAnalysis ? analysisMap : undefined };
            continue;
        }
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
        }> = [...(resume?.scanEvidence ?? [])];
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
                if (scanCache.size > 2)
                    scanCache.delete(scanCache.keys().next().value!);
            }
            return pending;
        };
        const checkpoint = (
            nextPly: number,
            pendingScan = false,
            pendingConfirmation?: TrainingMomentExtractionCheckpoint['pendingConfirmation'],
            pendingOpponentError?: boolean,
        ): TrainingMomentExtractionResult => ({
            engineWork: pool.report(),
            moments,
            manifests: [],
            configSnapshot,
            configHash,
            analysis: opts.returnAnalysis ? analysisMap : undefined,
            checkpoint: {
                version: 2,
                gameId: game.id,
                sourceGameId: sourceId,
                sourcePgnHash: pgnHash,
                configHash,
                nextPly,
                expectedPlies: moves.length,
                reassessDecisionPlies,
                moments,
                gameAnalysis,
                whiteMoveAccuracies,
                blackMoveAccuracies,
                extractionErrors: errors,
                decisionReceipts: [...receipts],
                previousMoveLoss: previousLoss,
                analysisPool: pool.serialize(),
                scanEvidence: scanRecords.length
                    ? scanRecords
                    : (resume?.scanEvidence ?? []),
                pendingScan,
                pendingConfirmation,
                pendingOpponentError,
            },
        });
        type ScannedCandidate = {
            best: EvalResult;
            after: EvalResult;
            loss: EvaluationLoss;
            beforeCp: number | null;
            afterCp: number | null;
            opponentError: boolean;
        };
        const candidates = new Map<number, ScannedCandidate>();
        const reportProgress = (ply: number, phase: TrainingMomentExtractionProgress['phase']) => {
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            args.onProgress?.({
                runId,
                gameId: game.id,
                gameIndex,
                gameCount: selected.length,
                ply,
                plyCount: moves.length,
                phase,
                fen: moves[ply]!.before,
                previousFen: moves[ply - 1]?.before,
                positionHistory: moves.slice(Math.max(0, ply - MAX_ASSESSMENT_POSITION_HISTORY), ply).map(item => item.before),
                userSide: userColor === 'w' ? 'white' : 'black',
            });
            if (args.signal?.aborted) throw new Error('Analysis aborted');
        };
        const decisionOutcomes = (): ExtractionCompletionManifest['decisionOutcomes'] =>
            [...receipts.values()].sort((a, b) => a.ply - b.ply).map(item => ({
                decisionPly: item.ply,
                status: item.status === 'SAVED' ? 'CONFIRMED_MISTAKE'
                    : item.reason === 'FORCED_MOVE' || item.reason === 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
                      ? 'NOT_A_MISTAKE' : 'UNRESOLVED',
                reason: item.reason,
            }));
        // FULL_GAME confirms inline so server checkpoints preserve their established
        // ply boundary. FIRST_PUZZLE scans once, then confirms only ranked candidates.
        const phases = firstPuzzle ? ['SCAN', 'CONFIRM'] as const : ['FULL'] as const;
        for (const phase of phases) {
            const plies = phase === 'CONFIRM'
                ? [...candidates.keys()].sort((left, right) => {
                    const a = candidates.get(left)!.loss;
                    const b = candidates.get(right)!.loss;
                    return (b.winningChance ?? 0) - (a.winningChance ?? 0) ||
                        (b.cp ?? 0) - (a.cp ?? 0) || left - right;
                })
                : Array.from({length: moves.length - startPly}, (_, index) => startPly + index);
            for (const ply of plies) {
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
                let best: EvalResult, after: EvalResult;
                let loss: EvaluationLoss;
                let beforeCp: number | null, afterCp: number | null;
                let opponentError: boolean;
                if (phase === 'CONFIRM') {
                    ({ best, after, loss, beforeCp, afterCp, opponentError } = candidates.get(ply)!);
                } else {
                    reportProgress(ply, 'scanning');
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
                        previousLoss = undefined;
                        scanned = ply + 1;
                        continue;
                    }
                    loss = evaluationLoss(
                        { score: best.score, wdl: best.wdl },
                        { score: negateScore(after.score), wdl: reverseWdl(after.wdl) },
                    );
                    beforeCp = scoreToCp(best.score);
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
                    opponentError =
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
                        reassessed.has(ply) ||
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
                    if (phase === 'SCAN') {
                        receipts.set(ply, decisionReceipt({ ply, reason: 'MISTAKE_COMPARISON_UNRESOLVED', loss }));
                        candidates.set(ply, { best, after, loss, beforeCp, afterCp, opponentError });
                        continue;
                    }
                }
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
                reportProgress(ply, 'confirming');
                let confirmed: ConfirmationCandidateResult & {
                    confirmationEvidence?: AdaptiveConfirmationEvidence;
                };
                try {
                    let tablebase = null;
                    if (!resume?.pendingConfirmation && args.tablebase && (pieceCountFromFen(fen) ?? Infinity) <= TABLEBASE_MAX_PIECES) {
                        try { tablebase = await args.tablebase.probe(fen, { signal: args.signal }); }
                        catch (error) { if (args.signal?.aborted) throw error; }
                    }
                    const exactRoot = assessPracticeExactPosition({ fen, positionHistory: previousFens,
                        trainingSide: side === 'w' ? 'WHITE' : 'BLACK', originalMoveUci,
                        policy: opts.gradingPolicy, tablebase });
                    confirmed =
                        resume?.pendingConfirmation && ply === startPly
                            ? resume.pendingConfirmation
                            : exactRoot && exactRoot.decision.status !== 'UNRESOLVED'
                              ? { exactRoot, confirmed: exactRoot.decision.status === 'CONFIRMED_MISTAKE', decision: exactRoot.decision }
                            : opts.confirmNodes != null &&
                                opts.maxConfirmationNodes != null
                              ? await confirmCandidateAdaptively({
                                    engine: args.engine,
                                    pool,
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
                                    signal: args.signal,
                                })
                              : await confirmCandidate({
                                    engine: args.engine,
                                    pool,
                                    beforeFen: fen,
                                    afterFen,
                                    solutionFen: fen,
                                    minimumWinningChanceLoss:
                                        opts.minWinningChanceLoss,
                                    fallbackMinimumLossCp: opts.fallbackMinCpLoss,
                                    gradingPolicy: opts.gradingPolicy,
                                    multiPv: opts.multiPv,
                                    limit: analysisLimit(opts, true, args.signal),
                                    minimumConfirmationNodes: opts.confirmNodes ?? 1,
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
                const finalBest = confirmed.newEval ?? (confirmed.exactRoot ? best : undefined);
                const finalAfter = confirmed.afterEval ?? (confirmed.exactRoot ? after : undefined);
                const finalLoss = confirmed.loss ?? loss;
                const canonicalDisproof = reassessed.has(ply) && confirmed.decision?.status === 'NOT_A_MISTAKE';
                if ((!confirmed.confirmed && !canonicalDisproof) || !finalBest || !finalAfter) {
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
                if (confirmed.confirmed && !firstPuzzle && !confirmed.exactRoot) await supplementPracticeCoverage({ pool, engine: args.engine, fen,
                    positionHistory: previousFens, trainingSide: side === 'w' ? 'WHITE' : 'BLACK',
                    originalMoveUci, minimumConfirmationNodes: opts.confirmNodes ?? 1,
                    policy: opts.gradingPolicy, signal: args.signal, timeoutMs: opts.engineTimeoutMs });
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
                    pool, opts, configHash, previousFens, exactRoot: confirmed.exactRoot,
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
                if (isTrainableSolution(built.solution) || reassessed.has(ply))
                    storeCanonicalTrainingMoment(moments, built);
                receipts.set(ply, {
                    ...decisionReceipt({
                        ply,
                        reason: built.solution.manifest.decision.selection === 'INCLUDED' ? 'MISTAKE_CONFIRMED'
                            : built.solution.manifest.decision.status === 'NOT_A_MISTAKE' ? 'ORIGINAL_MOVE_QUALITY_CONFIRMED'
                            : built.solution.manifest.decision.status === 'UNRESOLVED' ? 'MISTAKE_COMPARISON_UNRESOLVED'
                            : 'NO_MEANINGFUL_SELECTION_SIGNAL',
                        loss: finalLoss,
                        confirmation: confirmed.confirmationEvidence,
                    }),
                    sourceKinds: built.sourceKinds,
                });
                if (
                    firstPuzzle &&
                    isLandingReadyTrainingMoment(built)
                )
                    return {
                        engineWork: pool.report(),
                        moments: [built],
                        manifests: [...manifests, manifest('COMPLETED', moves.length, scanned, errors, decisionOutcomes())],
                        configSnapshot,
                        configHash,
                        analysis: opts.returnAnalysis ? analysisMap : undefined,
                    };
            }
        }
        const decisions = [...receipts.values()].sort((a, b) => a.ply - b.ply);
        const outcomes = decisionOutcomes();
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
                        isTrainableSolution(m.solution),
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
                    version: 2,
                    engineWork: extractionWorkSince(pool.report(), gameWorkStart),
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
                        multiPvMax: Math.max(opts.multiPv, 3),
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
        engineWork: pool.report(),
        moments,
        manifests,
        configSnapshot,
        configHash,
        analysis: opts.returnAnalysis ? analysisMap : undefined,
    };
}
