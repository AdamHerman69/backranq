import { Chess, type Move } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { classifyOpeningFromPgn } from '@/lib/chess/opening';
import type {
    EvalResult,
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
    type MoveClassification,
    classifyMove,
    calculateAccuracy,
    scoreToCp as classificationScoreToCp,
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
    maxPuzzlesPerGame?: number;
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
    maxPuzzlesPerGame: number;
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
};

function resolveOptions(options?: ExtractOptions): ResolvedOptions {
    return {
        movetimeMs: options?.movetimeMs ?? 200,
        maxPuzzlesPerGame: options?.maxPuzzlesPerGame ?? 5,
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
        const whiteCpLosses: number[] = [];
        const blackCpLosses: number[] = [];

        let cooldown = 0;
        for (let ply = 0; ply < plyCount; ply++) {
            if (puzzlesForGame >= opts.maxPuzzlesPerGame) break;
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

                // Track cp losses for accuracy calculation
                if (moverColor === 'w') {
                    whiteCpLosses.push(cpLoss);
                } else {
                    blackCpLosses.push(cpLoss);
                }

                const analyzedMove: AnalyzedMove = {
                    ply,
                    san: mv.san,
                    uci,
                    classification,
                    evalBefore: bestAtBefore.score,
                    evalAfter: bestAtAfter.score,
                    cpLoss,
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
                                    score: finalEval.score,
                                    label: 'Find the best move (avoid the mistake)',
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
                                            score: finalEval.score,
                                            label: 'Punish the blunder!',
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
            // Calculate accuracy scores
            const avgWhiteCpLoss =
                whiteCpLosses.length > 0
                    ? whiteCpLosses.reduce((a, b) => a + b, 0) /
                      whiteCpLosses.length
                    : 0;
            const avgBlackCpLoss =
                blackCpLosses.length > 0
                    ? blackCpLosses.reduce((a, b) => a + b, 0) /
                      blackCpLosses.length
                    : 0;

            analysisMap.set(game.id, {
                gameId: game.id,
                moves: gameAnalysis,
                whiteAccuracy: calculateAccuracy(avgWhiteCpLoss),
                blackAccuracy: calculateAccuracy(avgBlackCpLoss),
                analyzedAt: new Date().toISOString(),
            });
        }
    }

    return {
        puzzles,
        analysis: opts.returnAnalysis ? analysisMap : undefined,
    };
}
