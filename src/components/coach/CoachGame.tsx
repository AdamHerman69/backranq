'use client';

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import dynamic from 'next/dynamic';
import { Chess, type Move, type Square } from 'chess.js';
import {
    AlertTriangle,
    Brain,
    CheckCircle2,
    FlipHorizontal2,
    Loader2,
    ShieldCheck,
    WifiOff,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import { CoachInterventionCard } from '@/components/coach/CoachInterventionCard';
import { CoachMistakeReviewCard } from '@/components/coach/CoachMistakeReviewCard';
import { COACH_OFFLINE_READY_EVENT } from '@/components/coach/CoachOfflineRegistration';
import { CoachSetup } from '@/components/coach/CoachSetup';
import { useCoachEngine } from '@/components/coach/useCoachEngine';
import type { PositionAnalysisSeed } from '@/components/training/TrainingAnalysisWorkspace';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ModalDialog } from '@/components/ui/ModalDialog';
import type { MultiPvResult } from '@/lib/analysis/stockfishClient';
import { moveToUci, parseUci } from '@/lib/chess/utils';
import {
    assessUserMove,
    buildCoachVerification,
    COACH_CONFIRMATION_NODES,
    COACH_FIRST_PASS_NODES,
    COACH_OPPONENT_MULTIPV,
    COACH_OPPONENT_NODES,
    COACH_THRESHOLD_DEFAULT_CP,
    firstEvaluation,
    getCoachGameOutcome,
    getOpponentProfile,
    normalizeCoachThresholdCp,
    selectOpponentMove,
    shouldConfirmCoachAssessment,
    terminalEvaluation,
    type CoachGameOutcome,
    type OpponentProfileId,
} from '@/lib/coach';
import {
    clearCoachSession,
    loadCoachSession,
    saveCoachSession,
} from '@/lib/coach/sessionStore';
import { assertCoachPhaseTransition } from '@/lib/coach/stateMachine';
import type {
    CoachColorChoice as ColorChoice,
    CoachGamePhase as GamePhase,
    CoachMistake,
    CoachPendingDecision,
    CoachPlayedMove as PlayedMove,
    CoachPromotionPiece as PromotionPiece,
    CoachResumablePhase,
    CoachSessionSnapshot,
} from '@/lib/coach/types';
import { cn } from '@/lib/utils';

const PositionAnalysisWorkspace = dynamic(
    () =>
        import(
            '@/components/training/TrainingAnalysisWorkspace'
        ).then((module) => module.TrainingAnalysisWorkspace),
    {
        ssr: false,
        loading: () => (
            <div
                className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
            >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Preparing mistake analysis…
            </div>
        ),
    }
);

const START_FEN = new Chess().fen();

type PendingPromotion = {
    from: Square;
    to: Square;
    choices: PromotionPiece[];
};

function sessionKey(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function moveRows(moves: PlayedMove[]) {
    const rows: Array<{
        number: number;
        white?: PlayedMove;
        black?: PlayedMove;
    }> = [];
    for (const move of moves) {
        const number = Math.floor(move.ply / 2) + 1;
        const row = rows.find((candidate) => candidate.number === number) ?? {
            number,
        };
        if (!rows.includes(row)) rows.push(row);
        if (move.ply % 2 === 0) row.white = move;
        else row.black = move;
    }
    return rows;
}

function phaseMessage(phase: GamePhase, userColor: 'w' | 'b') {
    if (phase === 'starting') return 'Starting local Stockfish…';
    if (phase === 'preparing') return 'Coach is reading the position…';
    if (phase === 'checking') return 'Checking your decision…';
    if (phase === 'confirming') {
        return `Confirming the evaluation at ${Math.round(COACH_CONFIRMATION_NODES / 1_000)}k nodes…`;
    }
    if (phase === 'bot') return 'Opponent is choosing a move…';
    if (phase === 'mistake') return 'The coach paused the game.';
    if (phase === 'analysis') return 'Exploring the decision.';
    if (phase === 'gameover') return 'Game complete.';
    if (phase === 'recovering') return 'Restarting the local engine…';
    if (phase === 'error') return 'The local engine needs attention.';
    return userColor === 'w' ? 'Your move as White.' : 'Your move as Black.';
}

export function CoachGame({
    ownerId = null,
}: {
    ownerId?: string | null;
}) {
    const [phase, setPhaseState] = useState<GamePhase>('setup');
    const setPhase = useCallback((next: GamePhase) => {
        setPhaseState((current) =>
            assertCoachPhaseTransition(current, next)
        );
    }, []);
    const [colorChoice, setColorChoice] =
        useState<ColorChoice>('white');
    const [opponentId, setOpponentId] =
        useState<OpponentProfileId>('club');
    const [thresholdCp, setThresholdCp] = useState(
        COACH_THRESHOLD_DEFAULT_CP
    );
    const [userColor, setUserColor] = useState<'w' | 'b'>('w');
    const [gameFen, setGameFen] = useState(START_FEN);
    const [moves, setMoves] = useState<PlayedMove[]>([]);
    const [baseline, setBaseline] = useState<MultiPvResult | null>(null);
    const [mistake, setMistake] = useState<CoachMistake | null>(null);
    const [mistakes, setMistakes] = useState<CoachMistake[]>([]);
    const [outcome, setOutcome] = useState<CoachGameOutcome | null>(null);
    const [engineError, setEngineError] = useState<string | null>(null);
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const [flipped, setFlipped] = useState(false);
    const [restartDialogOpen, setRestartDialogOpen] = useState(false);
    const [online, setOnline] = useState(true);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardMoveError, setKeyboardMoveError] = useState<string | null>(
        null
    );
    const [resumableSession, setResumableSession] =
        useState<CoachSessionSnapshot | null>(null);
    const [sessionLoaded, setSessionLoaded] = useState(false);
    const [offlineAssetsReady, setOfflineAssetsReady] = useState(false);

    const gameRef = useRef(new Chess());
    const movesRef = useRef<PlayedMove[]>([]);
    const positionFensRef = useRef<string[]>([START_FEN]);
    const generationRef = useRef(0);
    const sessionKeyRef = useRef(sessionKey());
    const ownerIdRef = useRef(ownerId ?? 'local');
    const activeOpponentRef = useRef<OpponentProfileId>('club');
    const activeThresholdCpRef = useRef(COACH_THRESHOLD_DEFAULT_CP);
    const userColorRef = useRef<'w' | 'b'>('w');
    const pendingDecisionRef = useRef<CoachPendingDecision | null>(null);
    const lastSnapshotRef = useRef<CoachSessionSnapshot | null>(null);
    const {
        client: engineClient,
        status: engineWarmup,
        ensure: ensureEngine,
        prepare: prepareEngine,
        analyze: analyzeWithEngine,
        cancelSearch,
        terminate: terminateEngine,
    } = useCoachEngine();

    const canMove =
        phase === 'player' &&
        gameRef.current.turn() === userColor &&
        baseline !== null;

    const warmUpEngine = useCallback(async () => {
        setEngineError(null);
        const ready = await prepareEngine();
        if (!ready) {
            setEngineError(
                'The local Stockfish assets could not be prepared on this device.'
            );
        }
    }, [prepareEngine]);

    useEffect(() => {
        let cancelled = false;
        void loadCoachSession(ownerId ?? undefined).then((snapshot) => {
            if (cancelled) return;
            setResumableSession(snapshot);
            setSessionLoaded(true);
        });
        try {
            const saved = window.localStorage.getItem(
                'backranq.coach.thresholdCp'
            );
            if (saved != null) {
                setThresholdCp(normalizeCoachThresholdCp(saved));
            }
        } catch {
            // Preference persistence is best-effort.
        }
        return () => {
            cancelled = true;
        };
    }, [ownerId]);

    useEffect(() => {
        try {
            window.localStorage.setItem(
                'backranq.coach.thresholdCp',
                String(thresholdCp)
            );
        } catch {
            // Preference persistence is best-effort.
        }
    }, [thresholdCp]);

    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;
        let cancelled = false;
        const markReady = () => {
            void navigator.serviceWorker.ready.then(() => {
                if (!cancelled) setOfflineAssetsReady(true);
            });
        };
        void navigator.serviceWorker.getRegistration('/').then((registration) => {
            if (registration?.active) markReady();
        });
        navigator.serviceWorker.addEventListener(
            'controllerchange',
            markReady
        );
        window.addEventListener(
            COACH_OFFLINE_READY_EVENT,
            markReady
        );
        return () => {
            cancelled = true;
            navigator.serviceWorker.removeEventListener(
                'controllerchange',
                markReady
            );
            window.removeEventListener(
                COACH_OFFLINE_READY_EVENT,
                markReady
            );
        };
    }, []);

    useEffect(() => {
        if (phase !== 'setup' || engineWarmup !== 'idle') return;
        void warmUpEngine();
    }, [engineWarmup, phase, warmUpEngine]);

    useEffect(() => {
        const resumablePhase: CoachResumablePhase | null =
            phase === 'analysis'
                ? 'mistake'
                : phase === 'preparing' ||
                    phase === 'player' ||
                    phase === 'checking' ||
                    phase === 'confirming' ||
                    phase === 'bot' ||
                    phase === 'mistake'
                  ? phase
                  : null;
        if (!resumablePhase) {
            if (phase === 'gameover') {
                lastSnapshotRef.current = null;
                void clearCoachSession();
            }
            return;
        }
        const snapshot: CoachSessionSnapshot = {
            version: 1,
            sessionKey: sessionKeyRef.current,
            ownerId: ownerIdRef.current,
            savedAt: Date.now(),
            phase: resumablePhase,
            userColor: userColorRef.current,
            opponentId: activeOpponentRef.current,
            thresholdCp: activeThresholdCpRef.current,
            gameFen: gameRef.current.fen(),
            moves: movesRef.current,
            positionFens: positionFensRef.current,
            baseline,
            pendingDecision: pendingDecisionRef.current,
            mistake,
            mistakes,
            flipped,
        };
        lastSnapshotRef.current = snapshot;
        const timeout = window.setTimeout(() => {
            void saveCoachSession(snapshot);
        }, 80);
        return () => window.clearTimeout(timeout);
    }, [baseline, flipped, mistake, mistakes, moves, phase]);

    useEffect(() => {
        const update = () => setOnline(navigator.onLine);
        update();
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        return () => {
            window.removeEventListener('online', update);
            window.removeEventListener('offline', update);
        };
    }, []);

    const analyzePosition = useCallback(
        async (
            fen: string,
            generation: number,
            options: {
                nodes: number;
                multiPv: number;
            }
        ) => {
            const result = await analyzeWithEngine({
                fen,
                nodes: options.nodes,
                multiPv: options.multiPv,
                timeoutMs:
                    options.nodes >= COACH_CONFIRMATION_NODES
                        ? 30_000
                        : 20_000,
            });
            if (generationRef.current !== generation) {
                throw new Error('Coach search superseded');
            }
            return result;
        },
        [analyzeWithEngine]
    );

    const failEngine = useCallback(
        (error: unknown, generation: number) => {
            if (generationRef.current !== generation) return;
            const message =
                error instanceof Error ? error.message : String(error);
            if (
                message === 'Analysis aborted' ||
                message === 'Cancelled' ||
                message === 'Coach search superseded'
            ) {
                return;
            }
            terminateEngine('error');
            setEngineError(
                'Local Stockfish stopped before it could finish this turn.'
            );
            setPhase('error');
        },
        [setPhase, terminateEngine]
    );

    const appendMove = useCallback(
        (move: Move, actor: PlayedMove['actor'], fenBefore: string) => {
            const record: PlayedMove = {
                ply: movesRef.current.length,
                actor,
                san: move.san,
                uci: moveToUci(move).toLowerCase(),
                fenBefore,
                fenAfter: gameRef.current.fen(),
                from: move.from as Square,
                to: move.to as Square,
            };
            movesRef.current = [...movesRef.current, record];
            positionFensRef.current = [
                ...positionFensRef.current,
                record.fenAfter,
            ];
            setMoves(movesRef.current);
            setGameFen(record.fenAfter);
            return record;
        },
        []
    );

    const finishGame = useCallback(() => {
        const nextOutcome = getCoachGameOutcome(
            gameRef.current,
            userColorRef.current
        );
        if (!nextOutcome) return false;
        setOutcome(nextOutcome);
        setBaseline(null);
        setPhase('gameover');
        return true;
    }, [setPhase]);

    const preparePlayerTurn = useCallback(
        async (fen: string, generation: number) => {
            if (generationRef.current !== generation) return;
            if (finishGame()) return;
            setPhase('preparing');
            try {
                const analysis = await analyzePosition(fen, generation, {
                    nodes: COACH_FIRST_PASS_NODES,
                    multiPv: 1,
                });
                if (generationRef.current !== generation) return;
                setBaseline(analysis);
                setPhase('player');
            } catch (error) {
                failEngine(error, generation);
            }
        },
        [analyzePosition, failEngine, finishGame, setPhase]
    );

    const playOpponentFromAnalysis = useCallback(
        async (analysis: MultiPvResult, generation: number) => {
            if (generationRef.current !== generation) return;
            setPhase('bot');
            try {
                const fenBefore = gameRef.current.fen();
                const selected = selectOpponentMove({
                    fen: fenBefore,
                    analysis,
                    profileId: activeOpponentRef.current,
                });
                const parsed = parseUci(selected.moveUci);
                if (!parsed) {
                    throw new Error('Stockfish returned an invalid move.');
                }
                const move = gameRef.current.move({
                    from: parsed.from,
                    to: parsed.to,
                    promotion: parsed.promotion,
                });
                if (!move) {
                    throw new Error('Stockfish returned an illegal move.');
                }
                appendMove(move, 'bot', fenBefore);
                if (finishGame()) return;
                await preparePlayerTurn(
                    gameRef.current.fen(),
                    generation
                );
            } catch (error) {
                failEngine(error, generation);
            }
        },
        [appendMove, failEngine, finishGame, preparePlayerTurn, setPhase]
    );

    const playOpponentTurn = useCallback(
        async (fen: string, generation: number) => {
            if (generationRef.current !== generation) return;
            setPhase('bot');
            try {
                const analysis = await analyzePosition(fen, generation, {
                    nodes: COACH_OPPONENT_NODES,
                    multiPv: COACH_OPPONENT_MULTIPV,
                });
                await playOpponentFromAnalysis(analysis, generation);
            } catch (error) {
                failEngine(error, generation);
            }
        },
        [analyzePosition, failEngine, playOpponentFromAnalysis, setPhase]
    );

    const startGame = useCallback(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        cancelSearch();
        lastSnapshotRef.current = null;
        sessionKeyRef.current = sessionKey();
        ownerIdRef.current = ownerId ?? 'local';
        activeOpponentRef.current = opponentId;
        activeThresholdCpRef.current =
            normalizeCoachThresholdCp(thresholdCp);
        pendingDecisionRef.current = null;
        void clearCoachSession();
        setResumableSession(null);
        const resolvedColor =
            colorChoice === 'random'
                ? Math.random() < 0.5
                    ? 'w'
                    : 'b'
                : colorChoice === 'white'
                  ? 'w'
                  : 'b';
        userColorRef.current = resolvedColor;
        setUserColor(resolvedColor);
        gameRef.current = new Chess();
        movesRef.current = [];
        positionFensRef.current = [START_FEN];
        setMoves([]);
        setGameFen(START_FEN);
        setBaseline(null);
        setMistake(null);
        setMistakes([]);
        setOutcome(null);
        setEngineError(null);
        setSelectedSquare(null);
        setPendingPromotion(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        setFlipped(false);
        setPhase('starting');
        try {
            ensureEngine();
            if (resolvedColor === 'w') {
                void preparePlayerTurn(START_FEN, generation);
            } else {
                void playOpponentTurn(START_FEN, generation);
            }
        } catch (error) {
            failEngine(error, generation);
        }
    }, [
        colorChoice,
        cancelSearch,
        ensureEngine,
        failEngine,
        opponentId,
        ownerId,
        playOpponentTurn,
        preparePlayerTurn,
        setPhase,
        thresholdCp,
    ]);

    const checkPlayerMove = useCallback(
        async (
            record: PlayedMove,
            beforeAnalysis: MultiPvResult,
            generation: number
        ) => {
            if (generationRef.current !== generation) return;
            setPhase('checking');
            try {
                if (
                    new Chess(record.fenBefore).moves().length <= 1
                ) {
                    pendingDecisionRef.current = null;
                    if (finishGame()) return;
                    await playOpponentTurn(
                        record.fenAfter,
                        generation
                    );
                    return;
                }
                const terminalAfter = terminalEvaluation(gameRef.current);
                let afterAnalysis: MultiPvResult | null = null;
                let afterEvaluation = terminalAfter;
                if (!afterEvaluation) {
                    afterAnalysis = await analyzePosition(
                        record.fenAfter,
                        generation,
                        {
                            nodes: COACH_FIRST_PASS_NODES,
                            multiPv: 1,
                        }
                    );
                    afterEvaluation = firstEvaluation(afterAnalysis);
                }
                if (generationRef.current !== generation) return;
                const firstPassAssessment = assessUserMove({
                    before: firstEvaluation(beforeAnalysis),
                    after: afterEvaluation,
                    thresholdCp: activeThresholdCpRef.current,
                });
                let verifiedBeforeAnalysis = beforeAnalysis;
                let verifiedAfterAnalysis = afterAnalysis;
                let verifiedAfterEvaluation = afterEvaluation;
                let verification = buildCoachVerification({
                    firstPassBefore: firstEvaluation(beforeAnalysis),
                    firstPassAfter: afterEvaluation,
                    thresholdCp: activeThresholdCpRef.current,
                });

                if (
                    shouldConfirmCoachAssessment(
                        firstPassAssessment,
                        activeThresholdCpRef.current
                    )
                ) {
                    setPhase('confirming');
                    const confirmedBefore = await analyzePosition(
                        record.fenBefore,
                        generation,
                        {
                            nodes: COACH_CONFIRMATION_NODES,
                            multiPv: 1,
                        }
                    );
                    const confirmedAfter = terminalAfter
                        ? null
                        : await analyzePosition(
                              record.fenAfter,
                              generation,
                              {
                                  nodes: COACH_CONFIRMATION_NODES,
                                  multiPv: 1,
                              }
                          );
                    if (generationRef.current !== generation) return;
                    verifiedBeforeAnalysis = confirmedBefore;
                    verifiedAfterAnalysis = confirmedAfter;
                    verifiedAfterEvaluation =
                        terminalAfter ?? firstEvaluation(confirmedAfter!);
                    verification = buildCoachVerification({
                        firstPassBefore: firstEvaluation(beforeAnalysis),
                        firstPassAfter: afterEvaluation,
                        confirmedBefore: firstEvaluation(confirmedBefore),
                        confirmedAfter: verifiedAfterEvaluation,
                        thresholdCp: activeThresholdCpRef.current,
                    });
                }

                const { assessment, evidence } = verification;
                pendingDecisionRef.current = null;
                if (assessment.shouldIntervene) {
                    const bestLine =
                        verifiedBeforeAnalysis.lines
                            .slice()
                            .sort(
                                (left, right) =>
                                    left.multipv - right.multipv
                            )[0]?.pvUci ?? [];
                    const caught: CoachMistake = {
                        id: `${sessionKeyRef.current}:${record.ply}:${record.uci}:${Date.now()}`,
                        decisionPly: record.ply,
                        decisionFen: record.fenBefore,
                        fenAfterMove: record.fenAfter,
                        positionHistory:
                            positionFensRef.current.slice(0, -1),
                        moveUci: record.uci,
                        moveSan: record.san,
                        bestMoveUci:
                            bestLine[0] ??
                            verifiedBeforeAnalysis.bestMoveUci,
                        bestLineUci: bestLine,
                        beforeAnalysis: verifiedBeforeAnalysis,
                        afterAnalysis: verifiedAfterAnalysis,
                        afterEvaluation: verifiedAfterEvaluation,
                        assessment,
                        verification: evidence,
                    };
                    setMistake(caught);
                    setMistakes((current) => [...current, caught]);
                    setBaseline(null);
                    setPhase('mistake');
                    return;
                }
                if (finishGame()) return;
                setBaseline(null);
                await playOpponentTurn(record.fenAfter, generation);
            } catch (error) {
                failEngine(error, generation);
            }
        },
        [
            analyzePosition,
            failEngine,
            finishGame,
            playOpponentTurn,
            setPhase,
        ]
    );

    const commitPlayerMove = useCallback(
        (from: Square, to: Square, promotion?: PromotionPiece) => {
            if (!canMove || !baseline) return false;
            const fenBefore = gameRef.current.fen();
            let move: Move | null = null;
            try {
                move = gameRef.current.move({ from, to, promotion });
            } catch {
                return false;
            }
            if (!move) return false;
            const beforeAnalysis = baseline;
            const record = appendMove(move, 'player', fenBefore);
            pendingDecisionRef.current = {
                record,
                beforeAnalysis,
            };
            const checkpoint: CoachSessionSnapshot = {
                version: 1,
                sessionKey: sessionKeyRef.current,
                ownerId: ownerIdRef.current,
                savedAt: Date.now(),
                phase: 'checking',
                userColor: userColorRef.current,
                opponentId: activeOpponentRef.current,
                thresholdCp: activeThresholdCpRef.current,
                gameFen: record.fenAfter,
                moves: movesRef.current,
                positionFens: positionFensRef.current,
                baseline: null,
                pendingDecision: pendingDecisionRef.current,
                mistake: null,
                mistakes,
                flipped,
            };
            lastSnapshotRef.current = checkpoint;
            void saveCoachSession(checkpoint);
            setSelectedSquare(null);
            setPendingPromotion(null);
            setBaseline(null);
            void checkPlayerMove(
                record,
                beforeAnalysis,
                generationRef.current
            );
            return true;
        },
        [
            appendMove,
            baseline,
            canMove,
            checkPlayerMove,
            flipped,
            mistakes,
        ]
    );

    const playOrChoosePromotion = useCallback(
        (from: Square, to: Square) => {
            if (!canMove) return false;
            const choices = gameRef.current
                .moves({ square: from, verbose: true })
                .filter((move) => move.to === to && move.promotion)
                .map((move) => move.promotion as PromotionPiece);
            const unique = Array.from(new Set(choices));
            if (unique.length > 0) {
                setPendingPromotion({ from, to, choices: unique });
                return true;
            }
            return commitPlayerMove(from, to);
        },
        [canMove, commitPlayerMove]
    );

    const submitKeyboardMove = useCallback(() => {
        if (!canMove || !keyboardMove.trim()) return;
        try {
            const chess = new Chess(gameFen);
            const notation = keyboardMove.trim();
            const normalized = notation.toLowerCase();
            const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)
                ? chess.move({
                      from: normalized.slice(0, 2),
                      to: normalized.slice(2, 4),
                      promotion:
                          normalized.slice(4, 5) || undefined,
                  })
                : chess.move(notation);
            if (!move) throw new Error('Illegal move');
            if (
                !commitPlayerMove(
                    move.from as Square,
                    move.to as Square,
                    move.promotion as PromotionPiece | undefined
                )
            ) {
                throw new Error('Move could not be played');
            }
            setKeyboardMove('');
            setKeyboardMoveError(null);
        } catch {
            setKeyboardMoveError(
                'Enter a legal move such as Nf3, O-O, or g1f3.'
            );
        }
    }, [canMove, commitPlayerMove, gameFen, keyboardMove]);

    const retryMistake = useCallback(() => {
        if (!mistake) return;
        const undone = gameRef.current.undo();
        if (!undone) {
            setEngineError('The last move could not be restored.');
            setPhase('error');
            return;
        }
        movesRef.current = movesRef.current.slice(0, -1);
        positionFensRef.current = positionFensRef.current.slice(0, -1);
        setMoves(movesRef.current);
        setGameFen(gameRef.current.fen());
        setBaseline(mistake.beforeAnalysis);
        pendingDecisionRef.current = null;
        setMistake(null);
        setSelectedSquare(null);
        setPendingPromotion(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        setPhase('player');
    }, [mistake, setPhase]);

    const continueAfterMistake = useCallback(() => {
        if (!mistake) return;
        setMistake(null);
        setSelectedSquare(null);
        setPendingPromotion(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        if (finishGame()) return;
        void playOpponentTurn(
            gameRef.current.fen(),
            generationRef.current
        );
    }, [finishGame, mistake, playOpponentTurn]);

    const resumeCoachSession = useCallback(
        async (snapshot: CoachSessionSnapshot) => {
            const generation = generationRef.current + 1;
            generationRef.current = generation;
            cancelSearch();
            setPhase('recovering');
            setEngineError(null);

            const restored = new Chess();
            for (const record of snapshot.moves) {
                const parsed = parseUci(record.uci);
                if (!parsed) {
                    setEngineError(
                        'The saved game contains an invalid move.'
                    );
                    setPhase('error');
                    return;
                }
                restored.move({
                    from: parsed.from,
                    to: parsed.to,
                    promotion: parsed.promotion,
                });
            }

            sessionKeyRef.current = snapshot.sessionKey;
            ownerIdRef.current = snapshot.ownerId;
            activeOpponentRef.current = snapshot.opponentId;
            activeThresholdCpRef.current = snapshot.thresholdCp;
            userColorRef.current = snapshot.userColor;
            pendingDecisionRef.current = snapshot.pendingDecision;
            gameRef.current = restored;
            movesRef.current = snapshot.moves;
            positionFensRef.current = snapshot.positionFens;
            lastSnapshotRef.current = snapshot;
            setUserColor(snapshot.userColor);
            setOpponentId(snapshot.opponentId);
            setThresholdCp(snapshot.thresholdCp);
            setGameFen(restored.fen());
            setMoves(snapshot.moves);
            setBaseline(snapshot.baseline);
            setMistake(snapshot.mistake);
            setMistakes(snapshot.mistakes);
            setOutcome(null);
            setSelectedSquare(null);
            setPendingPromotion(null);
            setKeyboardMove('');
            setKeyboardMoveError(null);
            setFlipped(snapshot.flipped);
            setResumableSession(null);

            try {
                const ready = await prepareEngine();
                if (!ready) throw new Error('Engine restart failed');
                if (generationRef.current !== generation) return;
                if (
                    snapshot.phase === 'mistake' &&
                    snapshot.mistake
                ) {
                    setPhase('mistake');
                    return;
                }
                if (
                    (snapshot.phase === 'checking' ||
                        snapshot.phase === 'confirming') &&
                    snapshot.pendingDecision
                ) {
                    void checkPlayerMove(
                        snapshot.pendingDecision.record,
                        snapshot.pendingDecision.beforeAnalysis,
                        generation
                    );
                    return;
                }
                if (
                    snapshot.phase === 'bot' ||
                    restored.turn() !== snapshot.userColor
                ) {
                    void playOpponentTurn(restored.fen(), generation);
                    return;
                }
                void preparePlayerTurn(restored.fen(), generation);
            } catch {
                terminateEngine('error');
                setEngineError(
                    'The local engine could not be restarted. Your game remains saved on this device.'
                );
                setPhase('error');
            }
        },
        [
            checkPlayerMove,
            cancelSearch,
            playOpponentTurn,
            prepareEngine,
            preparePlayerTurn,
            setPhase,
            terminateEngine,
        ]
    );

    const recoverEngine = useCallback(() => {
        const snapshot =
            lastSnapshotRef.current ?? resumableSession;
        if (!snapshot) {
            setEngineError(
                'No valid local checkpoint is available for recovery.'
            );
            return;
        }
        terminateEngine('idle');
        void resumeCoachSession(snapshot);
    }, [resumableSession, resumeCoachSession, terminateEngine]);

    const returnToSetupKeepingSession = useCallback(() => {
        generationRef.current += 1;
        terminateEngine('idle');
        setEngineError(null);
        setResumableSession(lastSnapshotRef.current);
        setPhase('setup');
    }, [setPhase, terminateEngine]);

    const leaveAnalysisThen = useCallback((action: () => void) => {
        setPhase('mistake');
        window.setTimeout(action, 0);
    }, [setPhase]);

    const returnToSetup = useCallback(() => {
        generationRef.current += 1;
        cancelSearch();
        if (phase === 'error') {
            terminateEngine('idle');
        }
        setBaseline(null);
        setMistake(null);
        setSelectedSquare(null);
        setPendingPromotion(null);
        setEngineError(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        setOutcome(null);
        pendingDecisionRef.current = null;
        lastSnapshotRef.current = null;
        void clearCoachSession();
        setResumableSession(null);
        setPhase('setup');
        setRestartDialogOpen(false);
    }, [cancelSearch, phase, setPhase, terminateEngine]);

    const legalTargets = useMemo(() => {
        if (!canMove || !selectedSquare) return new Set<Square>();
        try {
            const chess = new Chess(gameFen);
            return new Set(
                chess.moves({
                    square: selectedSquare,
                    verbose: true,
                })
                .map((move) => move.to as Square)
            );
        } catch {
            return new Set<Square>();
        }
    }, [canMove, gameFen, selectedSquare]);

    const lastMove = moves.at(-1) ?? null;
    const squareStyles = useMemo(() => {
        const styles: Record<string, React.CSSProperties> = {};
        if (lastMove) {
            const color =
                phase === 'mistake'
                    ? 'rgba(239,68,68,0.34)'
                    : 'rgba(59,130,246,0.22)';
            styles[lastMove.from] = { backgroundColor: color };
            styles[lastMove.to] = { backgroundColor: color };
        }
        if (selectedSquare) {
            styles[selectedSquare] = {
                backgroundColor: 'rgba(59,130,246,0.32)',
            };
        }
        for (const square of legalTargets) {
            styles[square] = {
                background:
                    'radial-gradient(circle, rgba(59,130,246,0.52) 0 18%, transparent 20%)',
            };
        }
        return styles;
    }, [lastMove, legalTargets, phase, selectedSquare]);

    const rows = useMemo(() => moveRows(moves), [moves]);
    const normalizedThresholdCp =
        normalizeCoachThresholdCp(thresholdCp);

    if (phase === 'setup') {
        return (
            <CoachSetup
                colorChoice={colorChoice}
                engineError={engineError}
                engineWarmup={engineWarmup}
                normalizedThresholdCp={normalizedThresholdCp}
                offlineAssetsReady={offlineAssetsReady}
                opponentId={opponentId}
                resumableSession={resumableSession}
                sessionLoaded={sessionLoaded}
                thresholdCp={thresholdCp}
                onColorChoiceChange={setColorChoice}
                onDiscardSession={() => {
                    void clearCoachSession();
                    setResumableSession(null);
                }}
                onOpponentChange={setOpponentId}
                onResume={(snapshot) => void resumeCoachSession(snapshot)}
                onRetryEngine={() => void warmUpEngine()}
                onStart={startGame}
                onThresholdChange={setThresholdCp}
            />
        );
    }

    if (phase === 'analysis' && mistake) {
        const analysisSeed: PositionAnalysisSeed = {
            sessionKey: `coach:${mistake.id}`,
            revisionKey: 'coach-v1',
            decisionFen: mistake.decisionFen,
            sideToMove: userColor,
            positionHistory: mistake.positionHistory,
            originalMoveUci: null,
            submittedMoveUci: mistake.moveUci,
            bestLineUci: mistake.bestLineUci,
        };
        return (
            <section
                className="space-y-4"
                aria-label="Coach mistake analysis"
                data-coach-phase="analysis"
            >
                <PositionAnalysisWorkspace
                    active
                    initialFen={mistake.decisionFen}
                    positionSeed={analysisSeed}
                    engineClient={engineClient}
                    onRequestEngine={ensureEngine}
                    flipped={flipped}
                    onFlip={() => setFlipped((current) => !current)}
                    loadingNext={false}
                    onNext={() => setPhase('mistake')}
                    heading="Analyze the mistake"
                    description="Test alternatives from the decision point. Your sandbox stays local and does not change the game."
                    primaryActionLabel="Back to paused game"
                    primaryActionLoadingLabel="Returning…"
                    primaryActionShortcut="G"
                    primaryActionHint="game"
                >
                    <CoachMistakeReviewCard
                        mistake={mistake}
                        onRetry={() =>
                            leaveAnalysisThen(retryMistake)
                        }
                        onContinue={() =>
                            leaveAnalysisThen(continueAfterMistake)
                        }
                    />
                </PositionAnalysisWorkspace>
            </section>
        );
    }

    return (
        <section
            className="space-y-4"
            aria-label="Coach game"
            data-coach-phase={phase}
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold">
                        You are playing {userColor === 'w' ? 'White' : 'Black'}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {phaseMessage(phase, userColor)}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={online ? 'secondary' : 'outline'}>
                        {online ? (
                            <ShieldCheck
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden="true"
                            />
                        ) : (
                            <WifiOff
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden="true"
                            />
                        )}
                        {online ? 'Local engine' : 'Offline · local engine'}
                    </Badge>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setFlipped((current) => !current)}
                        aria-pressed={flipped}
                    >
                        <FlipHorizontal2
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                        />
                        Flip
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,560px)_minmax(300px,1fr)]">
                <div className="min-w-0">
                    <div
                        className={cn(
                            'rounded-xl border bg-card p-1 shadow-sm transition-colors sm:p-2',
                            phase === 'mistake' &&
                                'border-red-500/50 ring-2 ring-red-500/10'
                        )}
                        role="group"
                        aria-label="Coach game board"
                        aria-busy={
                            phase === 'starting' ||
                            phase === 'preparing' ||
                            phase === 'checking' ||
                            phase === 'confirming' ||
                            phase === 'recovering' ||
                            phase === 'bot'
                        }
                    >
                        <Chessboard
                            options={{
                                position: gameFen,
                                boardOrientation:
                                    (userColor === 'w') !== flipped
                                        ? 'white'
                                        : 'black',
                                allowDragging: canMove,
                                allowDrawingArrows: false,
                                squareStyles,
                                canDragPiece: ({ square }) => {
                                    if (!canMove || !square) return false;
                                    return (
                                        gameRef.current.get(square as Square)
                                            ?.color === userColor
                                    );
                                },
                                onSquareClick: ({ square }) => {
                                    if (!square || !canMove) return;
                                    const target = square as Square;
                                    if (
                                        selectedSquare &&
                                        legalTargets.has(target)
                                    ) {
                                        playOrChoosePromotion(
                                            selectedSquare,
                                            target
                                        );
                                        return;
                                    }
                                    const piece =
                                        gameRef.current.get(target);
                                    setSelectedSquare((current) =>
                                        piece?.color === userColor &&
                                        current !== target
                                            ? target
                                            : null
                                    );
                                },
                                onPieceDrop: ({
                                    sourceSquare,
                                    targetSquare,
                                }) => {
                                    setSelectedSquare(null);
                                    if (!targetSquare || !canMove) return false;
                                    return playOrChoosePromotion(
                                        sourceSquare as Square,
                                        targetSquare as Square
                                    );
                                },
                            }}
                        />
                    </div>

                    <div
                        className={cn(
                            'mt-3 flex min-h-12 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm',
                            phase === 'mistake'
                                ? 'border-red-500/35 bg-red-500/5 text-red-800 dark:text-red-200'
                                : phase === 'error'
                                  ? 'border-destructive/35 bg-destructive/5 text-destructive'
                                  : 'bg-card text-muted-foreground'
                        )}
                        role="status"
                        aria-live="polite"
                    >
                        {phase === 'starting' ||
                        phase === 'preparing' ||
                        phase === 'checking' ||
                        phase === 'confirming' ||
                        phase === 'recovering' ||
                        phase === 'bot' ? (
                            <Loader2
                                className="h-4 w-4 shrink-0 animate-spin"
                                aria-hidden="true"
                            />
                        ) : phase === 'mistake' ? (
                            <AlertTriangle
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                        ) : phase === 'gameover' ? (
                            <CheckCircle2
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                        ) : (
                            <Brain
                                className="h-4 w-4 shrink-0"
                                aria-hidden="true"
                            />
                        )}
                        <span>{phaseMessage(phase, userColor)}</span>
                    </div>
                </div>

                <div className="min-w-0 space-y-4">
                    {phase === 'mistake' && mistake ? (
                        <CoachInterventionCard
                            mistake={mistake}
                            thresholdCp={activeThresholdCpRef.current}
                            onAnalyze={() => setPhase('analysis')}
                            onContinue={continueAfterMistake}
                            onRetry={retryMistake}
                        />
                    ) : null}

                    {phase === 'gameover' && outcome ? (
                        <Card>
                            <CardHeader>
                                <CardTitle>{outcome.title}</CardTitle>
                                <CardDescription>
                                    {outcome.reason}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <p className="text-sm text-muted-foreground">
                                    {mistakes.length === 0
                                        ? 'No coach intervention was needed in this game.'
                                        : `${mistakes.length} ${mistakes.length === 1 ? 'decision was' : 'decisions were'} caught for review.`}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <Button type="button" onClick={startGame}>
                                        Rematch
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={returnToSetup}
                                    >
                                        Change setup
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ) : null}

                    {phase === 'error' ? (
                        <Card className="border-destructive/35">
                            <CardHeader>
                                <CardTitle className="text-base">
                                    Local engine interrupted
                                </CardTitle>
                            <CardDescription role="alert">
                                {engineError}
                            </CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    onClick={recoverEngine}
                                >
                                    Restart engine and resume
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={returnToSetupKeepingSession}
                                >
                                    Return later
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={returnToSetup}
                                >
                                    Abandon game
                                </Button>
                                <p className="w-full text-xs text-muted-foreground">
                                    Recovery replays the saved UCI moves and
                                    reruns the interrupted engine task. No move
                                    is applied twice.
                                </p>
                            </CardContent>
                        </Card>
                    ) : null}

                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex items-center justify-between gap-3">
                                <CardTitle className="text-base">
                                    Game
                                </CardTitle>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        phase === 'gameover'
                                            ? returnToSetup()
                                            : setRestartDialogOpen(true)
                                    }
                                >
                                    New game
                                </Button>
                            </div>
                            <CardDescription>
                                {getOpponentProfile(
                                    activeOpponentRef.current
                                ).label}{' '}
                                opponent · stop at ≥{' '}
                                {activeThresholdCpRef.current} cp
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {phase !== 'gameover' && phase !== 'error' ? (
                                <form
                                    className="space-y-2"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        submitKeyboardMove();
                                    }}
                                >
                                    <label
                                        htmlFor="coach-keyboard-move"
                                        className="text-sm font-medium"
                                    >
                                        Keyboard move
                                    </label>
                                    <div className="flex gap-2">
                                        <Input
                                            id="coach-keyboard-move"
                                            value={keyboardMove}
                                            disabled={!canMove}
                                            onChange={(event) => {
                                                setKeyboardMove(
                                                    event.target.value
                                                );
                                                setKeyboardMoveError(null);
                                            }}
                                            placeholder="Nf3 or g1f3"
                                            autoComplete="off"
                                            spellCheck={false}
                                        />
                                        <Button
                                            type="submit"
                                            variant="outline"
                                            disabled={
                                                !canMove ||
                                                !keyboardMove.trim()
                                            }
                                        >
                                            Play
                                        </Button>
                                    </div>
                                    {keyboardMoveError ? (
                                        <p
                                            className="text-xs text-destructive"
                                            role="alert"
                                        >
                                            {keyboardMoveError}
                                        </p>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            SAN and UCI notation are supported.
                                        </p>
                                    )}
                                </form>
                            ) : null}
                            {rows.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">
                                    The first move will appear here.
                                </p>
                            ) : (
                                <div className="max-h-64 overflow-y-auto rounded-lg border">
                                    <div className="grid grid-cols-[44px_1fr_1fr] text-sm">
                                        {rows.map((row) => (
                                            <div
                                                key={row.number}
                                                className="col-span-3 grid grid-cols-subgrid border-b last:border-b-0"
                                            >
                                                <span className="bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                                                    {row.number}.
                                                </span>
                                                <span
                                                    data-coach-move-ply={
                                                        row.white?.ply
                                                    }
                                                    className={cn(
                                                        'px-3 py-2 font-mono',
                                                        row.white?.actor ===
                                                            'player' &&
                                                            'font-semibold'
                                                    )}
                                                >
                                                    {row.white?.san ?? '…'}
                                                </span>
                                                <span
                                                    data-coach-move-ply={
                                                        row.black?.ply
                                                    }
                                                    className={cn(
                                                        'px-3 py-2 font-mono',
                                                        row.black?.actor ===
                                                            'player' &&
                                                            'font-semibold'
                                                    )}
                                                >
                                                    {row.black?.san ?? '…'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <ModalDialog
                open={pendingPromotion !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingPromotion(null);
                }}
                title="Promote pawn to"
                description="Choose the piece for your move."
            >
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(
                        [
                            ['q', 'Queen'],
                            ['r', 'Rook'],
                            ['b', 'Bishop'],
                            ['n', 'Knight'],
                        ] as const
                    )
                        .filter(([piece]) =>
                            pendingPromotion?.choices.includes(piece)
                        )
                        .map(([piece, label]) => (
                            <Button
                                key={piece}
                                type="button"
                                variant="outline"
                                onClick={() => {
                                    if (!pendingPromotion) return;
                                    commitPlayerMove(
                                        pendingPromotion.from,
                                        pendingPromotion.to,
                                        piece
                                    );
                                }}
                            >
                                {label}
                            </Button>
                        ))}
                </div>
            </ModalDialog>

            <ActionConfirmDialog
                open={restartDialogOpen}
                onOpenChange={setRestartDialogOpen}
                title="Leave this game?"
                description="The current game and its caught mistakes will be cleared from this session."
                confirmLabel="Start a new game"
                variant="destructive"
                onConfirm={returnToSetup}
            />
        </section>
    );
}
