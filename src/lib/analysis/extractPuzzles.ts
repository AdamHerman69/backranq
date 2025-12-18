import { Chess, type Move } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';
import type {
    EvalResult,
    MultiPvResult,
    Score,
    StockfishClient,
} from '@/lib/analysis/stockfishClient';
import type {
    Puzzle,
    PuzzleSeverity,
    PuzzleType,
} from '@/lib/analysis/puzzles';
import {
    type AnalyzedMove,
    type GameAnalysis,
    classifyMove,
    lichessGameAccuracy,
    lichessMoveAccuracyFromCps,
} from '@/lib/analysis/classification';

/**
 * Puzzle generation mode:
 * - "avoidBlunder": User is about to blunder, find the best move instead (puzzle starts BEFORE the mistake)
 * - "punishBlunder": Opponent blundered, user should punish (puzzle starts AFTER opponent's mistake)
 * - "both": Generate both types of puzzles
 */
export type PuzzleMode = 'avoidBlunder' | 'punishBlunder' | 'both';

export type ExtractOptions = {
    movetimeMs?: number;
    /**
     * Maximum puzzles to generate per game.
     * - number: cap
     * - null: unlimited
     */
    maxPuzzlesPerGame?: number | null;
    // Thresholds in centipawns (from mover perspective)
    blunderSwingCp?: number; // e.g. 250
    missedWinSwingCp?: number; // e.g. 150
    /**
     * "Missed tactic" threshold (big improvement available, but not necessarily already winning).
     * This is intentionally below blunderSwingCp so we can capture tactical misses that
     * don't always flip the game immediately.
     */
    missedTacticSwingCp?: number; // e.g. 180
    winningThresholdCp?: number; // e.g. 200
    /**
     * Skip analyzing the first N plies to avoid opening theory noise.
     * Defaults to 8.
     */
    openingSkipPlies?: number;
    /**
     * Optionally skip trivial endgames by piece-count heuristic (from FEN).
     * If enabled, positions with fewer than minNonKingPieces are skipped.
     */
    skipTrivialEndgames?: boolean;
    /** Count of non-king pieces required to analyze a position (default 4). */
    minNonKingPieces?: number;
    /**
     * Require the engine PV to be at least this many moves long.
     * Defaults to 2 to avoid "dead" positions.
     */
    minPvMoves?: number;
    /**
     * After finding a puzzle, skip analyzing the next N plies (but still replay moves)
     * to avoid clustering.
     */
    cooldownPliesAfterPuzzle?: number;

    // ─────────────────────────────────────────────────────────────────────────
    // QUALITY GATES
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Puzzle generation mode. Defaults to "both".
     */
    puzzleMode?: PuzzleMode;

    /**
     * Only allow positions where the starting eval (from puzzle solver's perspective)
     * is within [evalBandMinCp, evalBandMaxCp]. Filters out "already lost" or "already won" positions.
     * Set to null/undefined to disable.
     * Defaults: -300 to +600 (slightly losing to clearly winning is OK for tactics)
     */
    evalBandMinCp?: number | null;
    evalBandMaxCp?: number | null;

    /**
     * Require the solution to be "tactical": at least one of check, capture, or promotion
     * must occur in the first N plies of the PV. Defaults to true.
     */
    requireTactical?: boolean;
    /** How many plies into the PV to look for tactical moves. Defaults to 4. */
    tacticalLookaheadPlies?: number;

    /**
     * Re-evaluate candidate puzzles at higher depth to confirm they hold up.
     * If set, candidates are re-checked at this movetime; if the swing shrinks
     * below threshold or best move changes, the puzzle is discarded.
     * Set to 0 or null to disable. Defaults to 0 (disabled).
     */
    confirmMovetimeMs?: number | null;

    /**
     * Require the best move to be significantly better than the second-best move
     * by at least this many centipawns. Filters out "many moves win equally" puzzles.
     * Set to 0 or null to disable. Defaults to 0 (disabled, as it requires extra eval).
     */
    uniquenessMarginCp?: number | null;

    /**
     * For "avoid blunder" puzzles, optionally accept multiple moves as correct.
     * Uses MultiPV at the puzzle start and accepts moves whose eval is within
     * avoidBlunderAcceptableLossCp of the best move (from side-to-move POV).
     */
    avoidBlunderMultiPv?: number; // default 4 (clamped 1..5)
    avoidBlunderAcceptableLossCp?: number; // default 80
    avoidBlunderMaxAcceptedMoves?: number; // default 4

    /**
     * For ALL puzzle types, optionally accept multiple moves as correct when the
     * engine considers them essentially equivalent (MultiPV).
     *
     * This prevents "0.2 eval difference" second-lines from being graded as wrong.
     */
    multiSolutionMultiPv?: number; // default 4 (clamped 1..5)
    multiSolutionAcceptableLossCp?: number; // default 30
    multiSolutionMaxAcceptedMoves?: number; // default 4

    /**
     * If true, also return move-by-move analysis with classifications for each game.
     * This captures eval data for all analyzed moves, not just puzzle-worthy ones.
     * Defaults to false.
     */
    returnAnalysis?: boolean;
};

/**
 * Result of puzzle extraction, optionally including move analysis.
 */
export type ExtractResult = {
    puzzles: Puzzle[];
    /**
     * Move-by-move analysis for each game, keyed by game ID.
     * Only populated if options.returnAnalysis is true.
     */
    analysis?: Map<string, GameAnalysis>;
};

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function scoreToCp(score: Score | null): number | null {
    if (!score) return null;
    if (score.type === 'cp') return score.value;
    // Treat mate as huge (sign indicates mating side from side-to-move perspective in UCI)
    const sign = Math.sign(score.value || 1);
    return sign * 100000;
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
function isTacticalMove(
    chess: Chess,
    uciMove: string
): { isCheck: boolean; isCapture: boolean; isPromotion: boolean } {
    const parsed = parseUci(uciMove);
    if (!parsed)
        return { isCheck: false, isCapture: false, isPromotion: false };

    const isPromotion = !!parsed.promotion;

    // Check if target square has a piece (capture)
    const targetPiece = chess.get(parsed.to as Parameters<typeof chess.get>[0]);
    const isCapture = !!targetPiece;

    // Apply move temporarily to check for check
    let isCheck = false;
    try {
        const clone = new Chess(chess.fen());
        clone.move({
            from: parsed.from,
            to: parsed.to,
            promotion: parsed.promotion,
        });
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

        const { isCheck, isCapture, isPromotion } = isTacticalMove(chess, uci);
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

function normalizeUsername(s: string | undefined | null): string {
    return (s ?? '').trim().toLowerCase();
}

function userColorForGame(
    game: NormalizedGame,
    usernameByProvider?: { lichess?: string; chesscom?: string }
): 'w' | 'b' | null {
    const target = normalizeUsername(usernameByProvider?.[game.provider]);
    if (!target) return null;
    if (normalizeUsername(game.white?.name) === target) return 'w';
    if (normalizeUsername(game.black?.name) === target) return 'b';
    return null;
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

    // Sacrifice (very approximate): early material drop while still clearly winning at puzzle start.
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
                // We only tag once per puzzle to keep tags stable/low.
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

function severityFromSwing(swingCp: number): PuzzleSeverity {
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
}): { tags: string[]; severity: PuzzleSeverity } {
    const tags = new Set<string>();

    // Motif tags from puzzle start FEN + best line PV (deterministic, no extra engine calls).
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

    // Heuristic tag 2: hanging piece
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

    const severity = severityFromSwing(args.swingCp);
    return { tags: Array.from(tags).sort(), severity };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved options and helpers
// ─────────────────────────────────────────────────────────────────────────────

type ResolvedOptions = {
    movetimeMs: number;
    maxPuzzlesPerGame: number; // can be Infinity when unlimited
    blunderSwingCp: number;
    missedWinSwingCp: number;
    missedTacticSwingCp: number;
    winningThresholdCp: number;
    openingSkipPlies: number;
    skipTrivialEndgames: boolean;
    minNonKingPieces: number;
    minPvMoves: number;
    cooldownPliesAfterPuzzle: number;
    puzzleMode: PuzzleMode;
    evalBandMinCp: number | null;
    evalBandMaxCp: number | null;
    requireTactical: boolean;
    tacticalLookaheadPlies: number;
    confirmMovetimeMs: number | null;
    uniquenessMarginCp: number | null;
    returnAnalysis: boolean;

    avoidBlunderMultiPv: number;
    avoidBlunderAcceptableLossCp: number;
    avoidBlunderMaxAcceptedMoves: number;

    multiSolutionMultiPv: number;
    multiSolutionAcceptableLossCp: number;
    multiSolutionMaxAcceptedMoves: number;
};

function resolveOptions(options?: ExtractOptions): ResolvedOptions {
    const rawMax = options?.maxPuzzlesPerGame;
    const maxPuzzlesPerGame =
        rawMax === null ? Number.POSITIVE_INFINITY : rawMax ?? 5;

    return {
        movetimeMs: options?.movetimeMs ?? 200,
        maxPuzzlesPerGame,
        blunderSwingCp: options?.blunderSwingCp ?? 250,
        missedWinSwingCp: options?.missedWinSwingCp ?? 150,
        missedTacticSwingCp: options?.missedTacticSwingCp ?? 180,
        winningThresholdCp: options?.winningThresholdCp ?? 200,
        openingSkipPlies: options?.openingSkipPlies ?? 8,
        skipTrivialEndgames: options?.skipTrivialEndgames ?? true,
        minNonKingPieces: options?.minNonKingPieces ?? 4,
        minPvMoves: options?.minPvMoves ?? 2,
        cooldownPliesAfterPuzzle: options?.cooldownPliesAfterPuzzle ?? 1,
        puzzleMode: options?.puzzleMode ?? 'both',
        evalBandMinCp: options?.evalBandMinCp ?? -300,
        evalBandMaxCp: options?.evalBandMaxCp ?? 600,
        requireTactical: options?.requireTactical ?? true,
        tacticalLookaheadPlies: options?.tacticalLookaheadPlies ?? 4,
        confirmMovetimeMs: options?.confirmMovetimeMs ?? null,
        uniquenessMarginCp: options?.uniquenessMarginCp ?? null,
        returnAnalysis: options?.returnAnalysis ?? false,

        avoidBlunderMultiPv: Math.max(
            1,
            Math.min(5, Math.trunc(options?.avoidBlunderMultiPv ?? 4))
        ),
        avoidBlunderAcceptableLossCp:
            options?.avoidBlunderAcceptableLossCp ?? 80,
        avoidBlunderMaxAcceptedMoves: Math.max(
            1,
            Math.min(16, Math.trunc(options?.avoidBlunderMaxAcceptedMoves ?? 4))
        ),

        multiSolutionMultiPv: Math.max(
            1,
            Math.min(5, Math.trunc(options?.multiSolutionMultiPv ?? 4))
        ),
        multiSolutionAcceptableLossCp:
            options?.multiSolutionAcceptableLossCp ?? 30,
        multiSolutionMaxAcceptedMoves: Math.max(
            1,
            Math.min(
                16,
                Math.trunc(options?.multiSolutionMaxAcceptedMoves ?? 4)
            )
        ),
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

/**
 * Check if eval is within the allowed band (not already lost/won).
 * evalCp is from the puzzle solver's perspective (positive = good for solver).
 */
function isWithinEvalBand(
    evalCp: number,
    minCp: number | null,
    maxCp: number | null
): boolean {
    if (minCp != null && evalCp < minCp) return false;
    if (maxCp != null && evalCp > maxCp) return false;
    return true;
}

/**
 * Confirm a candidate puzzle at higher depth. Returns true if it still qualifies.
 */
async function confirmCandidate(args: {
    engine: StockfishClient;
    fen: string;
    originalBestMoveUci: string;
    confirmMovetimeMs: number;
}): Promise<{ confirmed: boolean; newEval?: EvalResult }> {
    const newEval = await args.engine.evalPosition({
        fen: args.fen,
        movetimeMs: args.confirmMovetimeMs,
    });

    // Best move must stay the same (or be consistent)
    if (newEval.bestMoveUci !== args.originalBestMoveUci) {
        return { confirmed: false, newEval };
    }

    return { confirmed: true, newEval };
}

function normalizeUci(uci: string): string {
    return (uci ?? '').trim().toLowerCase();
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

async function computeAcceptedMovesForPosition(args: {
    engine: StockfishClient;
    fen: string;
    movetimeMs: number;
    multiPv: number;
    acceptableLossCp: number;
    maxAcceptedMoves: number;
    bestMoveUci: string;
}): Promise<string[]> {
    const res: MultiPvResult = await args.engine.analyzeMultiPv({
        fen: args.fen,
        movetimeMs: args.movetimeMs,
        multiPv: args.multiPv,
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
            };
        })
        .filter((x) => x.uci && typeof x.cp === 'number');

    // Determine "best" score from multipv=1 if present, else top score.
    const bestLine = scored.find((l) => l.multipv === 1) ?? scored[0];
    const bestCp = typeof bestLine?.cp === 'number' ? bestLine.cp : null;
    if (bestCp == null) {
        // Fallback: only accept best move.
        return normalizeUciList(args.bestMoveUci, [], 1);
    }

    // Accept moves within acceptableLossCp of best (side-to-move POV).
    const accepted = scored
        .filter((l) => bestCp - (l.cp as number) <= args.acceptableLossCp)
        .map((l) => l.uci);

    // Always include best move, normalize/dedupe/limit.
    return normalizeUciList(args.bestMoveUci, accepted, args.maxAcceptedMoves);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main extraction function
// ─────────────────────────────────────────────────────────────────────────────

export async function extractPuzzlesFromGames(args: {
    games: NormalizedGame[];
    selectedGameIds: Set<string>;
    engine: StockfishClient;
    /**
     * Usernames used to determine "user color" per game. Case-insensitive match
     * against game.white.name / game.black.name.
     */
    usernameByProvider?: { lichess?: string; chesscom?: string };
    onProgress?: (p: {
        gameId: string;
        gameIndex: number;
        gameCount: number;
        ply: number;
        plyCount: number;
        phase?: string;
    }) => void;
    options?: ExtractOptions;
}): Promise<ExtractResult> {
    const opts = resolveOptions(args.options);

    const puzzles: Puzzle[] = [];
    const analysisMap = new Map<string, GameAnalysis>();
    const selected = args.games.filter((g) => args.selectedGameIds.has(g.id));

    for (let gi = 0; gi < selected.length; gi++) {
        const game = selected[gi];
        if (!game) continue;
        const opening = classifyOpeningFromPgn(game.pgn);
        const userColor = userColorForGame(game, args.usernameByProvider);
        // We need userColor to determine whose mistakes to track
        if (!userColor) continue;

        const chess = new Chess();
        try {
            chess.loadPgn(game.pgn, { strict: false });
        } catch {
            continue;
        }

        // Use verbose history so we replay by from/to (not SAN), which avoids "Invalid move: …" issues.
        const movesVerbose = chess.history({ verbose: true }) as Move[];
        const plyCount = movesVerbose.length;
        let puzzlesForGame = 0;

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

        let cooldown = 0;
        for (let ply = 0; ply < plyCount; ply++) {
            // For puzzle-only mode, stop once we've found enough.
            // For analysis mode (returnAnalysis), keep analyzing the whole game,
            // but stop *adding* puzzles once quota is reached.
            if (
                !opts.returnAnalysis &&
                puzzlesForGame >= opts.maxPuzzlesPerGame
            )
                break;
            const puzzlesAllowed = puzzlesForGame < opts.maxPuzzlesPerGame;
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

            // Determine if this move is by user or opponent
            const isUserMove = moverColor === userColor;
            const isOpponentMove = !isUserMove;

            // Skip opening plies and trivial endgames
            const shouldAnalyze =
                cooldown === 0 &&
                ply >= opts.openingSkipPlies &&
                (!opts.skipTrivialEndgames ||
                    nonKingPieceCountFromFen(fenBefore) >=
                        opts.minNonKingPieces);

            if (!shouldAnalyze) {
                // Still replay the move so later positions remain aligned.
                try {
                    const played = replay.move({
                        from: mv.from,
                        to: mv.to,
                        promotion: mv.promotion,
                    });
                    if (!played) break;

                    // Record move as book/skipped if analysis is requested
                    if (opts.returnAnalysis) {
                        const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
                        const isOpeningMove = ply < opts.openingSkipPlies;
                        gameAnalysis.push({
                            ply,
                            san: mv.san,
                            uci,
                            classification: isOpeningMove ? 'book' : 'good', // Skipped moves assumed okay
                            evalBefore: null,
                            evalAfter: null,
                            cpLoss: 0,
                        });
                    }
                } catch {
                    break;
                }
                if (cooldown > 0) cooldown--;
                continue;
            }

            // Eval at position before the move (best play).
            const bestAtBefore: EvalResult = await args.engine.evalPosition({
                fen: fenBefore,
                movetimeMs: opts.movetimeMs,
            });
            if (
                !bestAtBefore.pvUci ||
                bestAtBefore.pvUci.length < opts.minPvMoves
            ) {
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
            const bestAtAfter: EvalResult = await args.engine.evalPosition({
                fen: fenAfter,
                movetimeMs: opts.movetimeMs,
            });

            const afterCpStm = scoreToCp(bestAtAfter.score);
            if (bestCpBefore == null || afterCpStm == null) continue;

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
                const { isCheck, isCapture } = isTacticalMove(
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
                    isBookMove: ply < opts.openingSkipPlies,
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

            // ─────────────────────────────────────────────────────────────────
            // PUZZLE MODE 1: "Avoid the blunder" (user made a mistake)
            // Puzzle: position BEFORE user's mistake, find the best move
            // ─────────────────────────────────────────────────────────────────
            if (
                puzzlesAllowed &&
                isUserMove &&
                (opts.puzzleMode === 'avoidBlunder' ||
                    opts.puzzleMode === 'both') &&
                swing >= opts.missedTacticSwingCp
            ) {
                // Eval band check: from user's perspective at puzzle start
                const userEvalAtStart = perspectiveCp(
                    bestCpBefore,
                    userColor,
                    stm
                );
                if (
                    isWithinEvalBand(
                        userEvalAtStart,
                        opts.evalBandMinCp,
                        opts.evalBandMaxCp
                    )
                ) {
                    // Tactical check
                    const isTactical =
                        !opts.requireTactical ||
                        pvContainsTactic(
                            fenBefore,
                            bestAtBefore.pvUci,
                            opts.tacticalLookaheadPlies
                        );

                    if (isTactical) {
                        // Determine puzzle type
                        let type: PuzzleType | null = null;
                        if (swing >= opts.blunderSwingCp) type = 'blunder';
                        else if (
                            beforeCpMover >= opts.winningThresholdCp &&
                            swing >= opts.missedWinSwingCp
                        )
                            type = 'missedWin';
                        else if (swing >= opts.missedTacticSwingCp)
                            type = 'missedTactic';

                        if (type) {
                            // Optional confirmation pass
                            let finalEval = bestAtBefore;
                            let confirmed = true;
                            if (
                                opts.confirmMovetimeMs &&
                                opts.confirmMovetimeMs > opts.movetimeMs
                            ) {
                                args.onProgress?.({
                                    gameId: game.id,
                                    gameIndex: gi,
                                    gameCount: selected.length,
                                    ply,
                                    plyCount,
                                    phase: 'confirming',
                                });
                                const result = await confirmCandidate({
                                    engine: args.engine,
                                    fen: fenBefore,
                                    originalBestMoveUci:
                                        bestAtBefore.bestMoveUci,
                                    confirmMovetimeMs: opts.confirmMovetimeMs,
                                });
                                confirmed = result.confirmed;
                                if (result.newEval) finalEval = result.newEval;
                            }

                            if (confirmed) {
                                const tagsAndSeverity = tagsForCandidate({
                                    fenBefore,
                                    fenAfter,
                                    moverColor,
                                    bestAtBefore: finalEval,
                                    bestAtAfter,
                                    swingCp: swing,
                                });
                                const tags = new Set<string>(
                                    tagsAndSeverity.tags
                                );
                                tags.add('avoidBlunder');
                                if (opening.eco) tags.add(`eco:${opening.eco}`);
                                if (opening.name)
                                    tags.add(`opening:${opening.name}`);
                                if (opening.variation)
                                    tags.add(`openingVar:${opening.variation}`);

                                const puzzleId = uid(`puz-avoid-${type}`);
                                let acceptedMovesUci: string[] | undefined =
                                    undefined;
                                let acceptedMovesError = false;
                                try {
                                    acceptedMovesUci =
                                        await computeAcceptedMovesForPosition({
                                            engine: args.engine,
                                            fen: fenBefore,
                                            movetimeMs: opts.movetimeMs,
                                            multiPv: opts.avoidBlunderMultiPv,
                                            acceptableLossCp:
                                                opts.avoidBlunderAcceptableLossCp,
                                            maxAcceptedMoves:
                                                opts.avoidBlunderMaxAcceptedMoves,
                                            bestMoveUci: finalEval.bestMoveUci,
                                        });
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
                                          opts.avoidBlunderMaxAcceptedMoves
                                      );
                                const isMulti = acceptedNormalized.length > 1;
                                if (isMulti) tags.add('multiSolution');
                                else tags.delete('multiSolution');
                                if (acceptedMovesError)
                                    tags.add('acceptedMovesMissing');

                                const puzzle: Puzzle = {
                                    id: puzzleId,
                                    type,
                                    provider: game.provider,
                                    sourceGameId: game.id,
                                    sourcePly: ply,
                                    playedAt: game.playedAt,
                                    fen: fenBefore,
                                    sideToMove: stm,
                                    bestLineUci: finalEval.pvUci,
                                    bestMoveUci: finalEval.bestMoveUci,
                                    acceptedMovesUci: isMulti
                                        ? acceptedNormalized
                                        : undefined,
                                    score: finalEval.score,
                                    label: isMulti
                                        ? 'Avoid the blunder — play a safe move'
                                        : 'Find the best move (avoid the mistake)',
                                    tags: Array.from(tags).sort(),
                                    opening,
                                    severity: tagsAndSeverity.severity,
                                };

                                puzzles.push(puzzle);
                                puzzlesForGame++;

                                // Link puzzle to analyzed move
                                if (
                                    opts.returnAnalysis &&
                                    gameAnalysis.length > 0
                                ) {
                                    const lastMove =
                                        gameAnalysis[gameAnalysis.length - 1];
                                    if (lastMove && lastMove.ply === ply) {
                                        lastMove.hasPuzzle = true;
                                        lastMove.puzzleId = puzzleId;
                                        lastMove.puzzleType = 'avoidBlunder';
                                    }
                                }

                                cooldown = Math.max(
                                    0,
                                    Math.trunc(opts.cooldownPliesAfterPuzzle)
                                );
                            }
                        }
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // PUZZLE MODE 2: "Punish the blunder" (opponent made a mistake)
            // Puzzle: position AFTER opponent's mistake, user finds the punishment
            // Only if user DIDN'T punish it in the game
            // ─────────────────────────────────────────────────────────────────
            if (
                puzzlesAllowed &&
                isOpponentMove &&
                (opts.puzzleMode === 'punishBlunder' ||
                    opts.puzzleMode === 'both') &&
                swing >= opts.missedTacticSwingCp && // opponent blundered
                puzzlesForGame < opts.maxPuzzlesPerGame
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

                        // The best move at fenAfter (after opponent blundered) is bestAtAfter.bestMoveUci
                        // If user played something different, they missed the punishment
                        const userPunished =
                            userResponseUci === bestAtAfter.bestMoveUci;

                        if (!userPunished) {
                            // Eval band check: from user's perspective at puzzle start (fenAfter)
                            // User is now to move at fenAfter, and eval is from side-to-move perspective
                            // At fenAfter, it's user's turn, so afterCpStm is from user's perspective
                            const userEvalAtPuzzleStart = afterCpStm;

                            if (
                                isWithinEvalBand(
                                    userEvalAtPuzzleStart,
                                    opts.evalBandMinCp,
                                    opts.evalBandMaxCp
                                )
                            ) {
                                // Tactical check on the punishment PV
                                const isTactical =
                                    !opts.requireTactical ||
                                    pvContainsTactic(
                                        fenAfter,
                                        bestAtAfter.pvUci,
                                        opts.tacticalLookaheadPlies
                                    );

                                if (
                                    isTactical &&
                                    bestAtAfter.pvUci.length >= opts.minPvMoves
                                ) {
                                    // Optional confirmation pass
                                    let finalEval = bestAtAfter;
                                    let confirmed = true;
                                    if (
                                        opts.confirmMovetimeMs &&
                                        opts.confirmMovetimeMs > opts.movetimeMs
                                    ) {
                                        args.onProgress?.({
                                            gameId: game.id,
                                            gameIndex: gi,
                                            gameCount: selected.length,
                                            ply: nextPly,
                                            plyCount,
                                            phase: 'confirming',
                                        });
                                        const result = await confirmCandidate({
                                            engine: args.engine,
                                            fen: fenAfter,
                                            originalBestMoveUci:
                                                bestAtAfter.bestMoveUci,
                                            confirmMovetimeMs:
                                                opts.confirmMovetimeMs,
                                        });
                                        confirmed = result.confirmed;
                                        if (result.newEval)
                                            finalEval = result.newEval;
                                    }

                                    if (confirmed) {
                                        const tagsAndSeverity =
                                            tagsForCandidate({
                                                fenBefore: fenAfter, // puzzle starts here
                                                fenAfter: fenAfter, // same for now
                                                moverColor: userColor,
                                                bestAtBefore: finalEval,
                                                bestAtAfter: finalEval,
                                                swingCp: swing,
                                            });
                                        const tags = new Set<string>(
                                            tagsAndSeverity.tags
                                        );
                                        tags.add('punishBlunder');
                                        if (opening.eco)
                                            tags.add(`eco:${opening.eco}`);
                                        if (opening.name)
                                            tags.add(`opening:${opening.name}`);
                                        if (opening.variation)
                                            tags.add(
                                                `openingVar:${opening.variation}`
                                            );

                                        const puzzleId = uid(`puz-punish`);
                                        let acceptedMovesUci:
                                            | string[]
                                            | undefined = undefined;
                                        let acceptedMovesError = false;
                                        try {
                                            acceptedMovesUci =
                                                await computeAcceptedMovesForPosition(
                                                    {
                                                        engine: args.engine,
                                                        fen: fenAfter,
                                                        movetimeMs:
                                                            opts.movetimeMs,
                                                        multiPv:
                                                            opts.multiSolutionMultiPv,
                                                        acceptableLossCp:
                                                            opts.multiSolutionAcceptableLossCp,
                                                        maxAcceptedMoves:
                                                            opts.multiSolutionMaxAcceptedMoves,
                                                        bestMoveUci:
                                                            finalEval.bestMoveUci,
                                                    }
                                                );
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
                                                      opts.multiSolutionMaxAcceptedMoves
                                                  );
                                        const isMulti =
                                            acceptedNormalized.length > 1;
                                        if (isMulti) tags.add('multiSolution');
                                        else tags.delete('multiSolution');
                                        if (acceptedMovesError)
                                            tags.add('acceptedMovesMissing');

                                        const puzzle: Puzzle = {
                                            id: puzzleId,
                                            type: 'blunder', // It's always a blunder by opponent
                                            provider: game.provider,
                                            sourceGameId: game.id,
                                            sourcePly: nextPly, // Puzzle starts after opponent's blunder
                                            playedAt: game.playedAt,
                                            fen: fenAfter,
                                            sideToMove: userColor,
                                            bestLineUci: finalEval.pvUci,
                                            bestMoveUci: finalEval.bestMoveUci,
                                            acceptedMovesUci: isMulti
                                                ? acceptedNormalized
                                                : undefined,
                                            score: finalEval.score,
                                            label: isMulti
                                                ? 'Find a strong continuation (multiple correct moves)'
                                                : 'Punish the blunder!',
                                            tags: Array.from(tags).sort(),
                                            opening,
                                            severity: tagsAndSeverity.severity,
                                        };

                                        puzzles.push(puzzle);
                                        puzzlesForGame++;

                                        // Link puzzle to analyzed move (the opponent's blunder)
                                        if (
                                            opts.returnAnalysis &&
                                            gameAnalysis.length > 0
                                        ) {
                                            const lastMove =
                                                gameAnalysis[
                                                    gameAnalysis.length - 1
                                                ];
                                            if (
                                                lastMove &&
                                                lastMove.ply === ply
                                            ) {
                                                lastMove.hasPuzzle = true;
                                                lastMove.puzzleId = puzzleId;
                                                lastMove.puzzleType =
                                                    'punishBlunder';
                                            }
                                        }

                                        cooldown = Math.max(
                                            0,
                                            Math.trunc(
                                                opts.cooldownPliesAfterPuzzle
                                            )
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Store game analysis if requested
        if (opts.returnAnalysis && gameAnalysis.length > 0) {
            const round1 = (n: number) => Math.round(n * 10) / 10;
            const whiteAccuracy = lichessGameAccuracy({
                moveAccuracies: whiteMoveAccuracies,
            });
            const blackAccuracy = lichessGameAccuracy({
                moveAccuracies: blackMoveAccuracies,
            });

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
                analyzedAt: new Date().toISOString(),
            });
        }
    }

    return {
        puzzles,
        analysis: opts.returnAnalysis ? analysisMap : undefined,
    };
}
