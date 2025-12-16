'use client';

import { useMemo, useState } from 'react';
import { Chess, type Move as VerboseMove } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import styles from '@/app/page.module.css';
import { extractStartFenFromPgn } from '@/lib/chess/utils';
import { getClassificationSymbol } from '@/lib/analysis/classification';
import type { GameAnalysis } from '@/lib/analysis/classification';

type PuzzlePreview = {
    sourcePly: number;
    type: string;
    bestMoveUci: string;
};

const START_FEN = new Chess().fen();

export function GameViewer({
    pgn,
    metaLabel,
    analysis,
    puzzles,
}: {
    pgn: string;
    metaLabel?: string;
    analysis?: GameAnalysis | null;
    puzzles?: PuzzlePreview[];
}) {
    const [ply, setPly] = useState(0);

    const parsed = useMemo(() => {
        const chess = new Chess();
        try {
            chess.loadPgn(pgn, { strict: false });
        } catch {
            return null;
        }
        const moves = chess.history(); // SAN
        const startFen = (() => {
            const fenTag = extractStartFenFromPgn(pgn);
            if (fenTag) return fenTag;
            const c2 = new Chess();
            try {
                c2.loadPgn(pgn, { strict: false });
                while (c2.undo()) {}
                return c2.fen();
            } catch {
                return START_FEN;
            }
        })();
        return { moves, startFen };
    }, [pgn]);

    const fen = useMemo(() => {
        if (!parsed) return START_FEN;
        const c = new Chess(parsed.startFen);
        for (let i = 0; i < Math.min(ply, parsed.moves.length); i++) {
            try {
                c.move(parsed.moves[i]);
            } catch {
                break;
            }
        }
        return c.fen();
    }, [parsed, ply]);

    const puzzleByPly = useMemo(() => {
        const m = new Map<number, PuzzlePreview>();
        for (const p of puzzles ?? []) m.set(p.sourcePly, p);
        return m;
    }, [puzzles]);

    if (!parsed) {
        return <div className={styles.muted}>Unable to parse PGN.</div>;
    }

    return (
        <div className={styles.viewer}>
            <div className={styles.board}>
                <Chessboard options={{ position: fen, allowDragging: false }} />
                <div className={styles.scrub}>
                    <button
                        className={styles.secondaryButton}
                        onClick={() => setPly(0)}
                        disabled={ply === 0}
                    >
                        Start
                    </button>
                    <button
                        className={styles.secondaryButton}
                        onClick={() => setPly((p) => Math.max(0, p - 1))}
                        disabled={ply === 0}
                    >
                        Back
                    </button>
                    <div className={styles.muted}>
                        Ply {ply} / {parsed.moves.length}
                    </div>
                    <button
                        className={styles.secondaryButton}
                        onClick={() => setPly((p) => Math.min(parsed.moves.length, p + 1))}
                        disabled={ply >= parsed.moves.length}
                    >
                        Next
                    </button>
                    <button
                        className={styles.secondaryButton}
                        onClick={() => setPly(parsed.moves.length)}
                        disabled={ply >= parsed.moves.length}
                    >
                        End
                    </button>
                </div>
            </div>

            <div className={styles.moves}>
                {metaLabel ? <div className={styles.muted}>{metaLabel}</div> : null}
                {analysis ? (
                    <div className={styles.accuracyBar}>
                        <span className={`${styles.accuracyBadge} ${styles.accuracyWhite}`}>
                            ♔ {analysis.whiteAccuracy?.toFixed(1) ?? '—'}%
                        </span>
                        <span className={`${styles.accuracyBadge} ${styles.accuracyBlack}`}>
                            ♚ {analysis.blackAccuracy?.toFixed(1) ?? '—'}%
                        </span>
                    </div>
                ) : null}

                <ol className={styles.moveList}>
                    {parsed.moves.map((m, idx) => {
                        const analyzedMove = analysis?.moves?.find((am) => am.ply === idx);
                        const puzzle = puzzleByPly.get(idx);
                        const classificationClass = analyzedMove
                            ? // reuse existing CSS in page.module.css (moveBrilliant, moveBest, etc.)
                              (styles as any)[`move${analyzedMove.classification.charAt(0).toUpperCase()}${analyzedMove.classification.slice(1)}`] ?? ''
                            : '';
                        const hasPuzzle = !!puzzle || analyzedMove?.hasPuzzle;
                        const symbol = analyzedMove
                            ? getClassificationSymbol(analyzedMove.classification)
                            : '';

                        const tooltipParts: string[] = [];
                        if (analyzedMove) {
                            tooltipParts.push(`${analyzedMove.classification}`);
                            if (analyzedMove.cpLoss > 0)
                                tooltipParts.push(`-${analyzedMove.cpLoss}cp`);
                            if (analyzedMove.bestMoveSan && analyzedMove.san !== analyzedMove.bestMoveSan) {
                                tooltipParts.push(`Best: ${analyzedMove.bestMoveSan}`);
                            }
                        }
                        if (puzzle) tooltipParts.push(`📋 Puzzle: ${puzzle.type}`);

                        return (
                            <li key={`${idx}-${m}`}>
                                <button
                                    className={`${idx + 1 === ply ? styles.moveActive : styles.moveButton} ${classificationClass} ${hasPuzzle ? styles.puzzleMove : ''}`}
                                    onClick={() => setPly(idx + 1)}
                                    title={tooltipParts.length > 0 ? tooltipParts.join(' • ') : undefined}
                                >
                                    {m}
                                    {symbol ? (
                                        <span className={styles.classificationSymbol}>
                                            {symbol}
                                        </span>
                                    ) : null}
                                    {hasPuzzle ? <span className={styles.puzzleIndicator} /> : null}
                                </button>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}


