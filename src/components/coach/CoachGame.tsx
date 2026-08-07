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
    RotateCcw,
    ShieldCheck,
    WifiOff,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import { CoachInterventionCard } from '@/components/coach/CoachInterventionCard';
import { CoachMistakeReviewCard } from '@/components/coach/CoachMistakeReviewCard';
import { COACH_OFFLINE_READY_EVENT } from '@/components/coach/CoachOfflineRegistration';
import { CoachSetup } from '@/components/coach/CoachSetup';
import { useCoachEngine } from '@/components/coach/useCoachEngine';
import { useMaiaOpponent } from '@/components/coach/useMaiaOpponent';
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
import {
    isStructurallyCompleteMultiPvBundle,
    type MultiPvResult,
} from '@/lib/analysis/stockfishClient';
import { moveToUci, parseUci } from '@/lib/chess/utils';
import {
    assessUserMove,
    buildCoachVerification,
    COACH_CONFIRMATION_NODES,
    COACH_FIRST_PASS_NODES,
    COACH_OPPONENT_MULTIPV,
    COACH_OPPONENT_NODES,
    COACH_THRESHOLD_DEFAULT_CP,
    MAIA_OPPONENT_DEFAULT_ELO,
    MAIA_TACTICAL_GUARD_DEFAULT_CP,
    MAIA_TACTICAL_GUARD_CANDIDATES,
    MAIA_TACTICAL_GUARD_NODES,
    STOCKFISH_OPPONENT_REVISION,
    coachOpponentEngineRevision,
    deriveMaiaOpponentSeed,
    firstEvaluation,
    getCoachGameOutcome,
    getOpponentProfile,
    isMaiaOpponentModel,
    isMaiaTacticalGuardModel,
    isCompatibleCoachOpponentRevision,
    normalizeMaiaOpponentElo,
    normalizeMaiaTacticalGuardCp,
    normalizeCoachThresholdCp,
    selectOpponentMove,
    selectTacticalGuardMove,
    shouldConfirmCoachAssessment,
    terminalEvaluation,
    type CoachOpponentModelId,
    type CoachGameOutcome,
    type OpponentProfileId,
} from '@/lib/coach';
import { MAIA_MODEL } from '@/lib/coach/maia';
import { resolveCoachOwnerId } from '@/lib/coach/offlineOwner';
import {
    allowCoachSessionPersistence,
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
import { saveCompletedCoachGameAndAnalyze } from '@/lib/coach/completedGame';

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

function phaseMessage(
    phase: GamePhase,
    userColor: 'w' | 'b',
    opponentModel: CoachOpponentModelId
) {
    if (phase === 'starting') {
        return isMaiaOpponentModel(opponentModel)
            ? 'Starting the Stockfish judge and Maia opponent…'
            : 'Starting local Stockfish…';
    }
    if (phase === 'preparing') {
        return 'Stockfish judge is reading the position…';
    }
    if (phase === 'checking') return 'Stockfish is checking your decision…';
    if (phase === 'confirming') {
        return `Confirming the evaluation at ${Math.round(COACH_CONFIRMATION_NODES / 1_000)}k nodes…`;
    }
    if (phase === 'bot') {
        return isMaiaTacticalGuardModel(opponentModel)
            ? 'Maia is choosing a move and Stockfish is checking it…'
            : opponentModel === 'maia3'
              ? 'Maia is choosing a human-like move…'
            : 'Stockfish opponent is choosing a move…';
    }
    if (phase === 'mistake') return 'The coach paused the game.';
    if (phase === 'analysis') return 'Exploring the decision.';
    if (phase === 'gameover') return 'Game complete.';
    if (phase === 'recovering') {
        return 'Restarting the local judge and opponent…';
    }
    if (phase === 'error') {
        return 'The local judge or opponent needs attention.';
    }
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
    const [opponentModel, setOpponentModel] =
        useState<CoachOpponentModelId>('stockfish');
    const [opponentId, setOpponentId] =
        useState<OpponentProfileId>('club');
    const [maiaElo, setMaiaElo] = useState(
        MAIA_OPPONENT_DEFAULT_ELO
    );
    const [tacticalGuardCp, setTacticalGuardCp] = useState(
        MAIA_TACTICAL_GUARD_DEFAULT_CP
    );
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
    const [completedGameStatus, setCompletedGameStatus] = useState<
        'idle' | 'saving' | 'analyzing' | 'saved' | 'error'
    >('idle');
    const [completedGameError, setCompletedGameError] = useState<string | null>(
        null
    );
    const [engineError, setEngineError] = useState<string | null>(null);
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const [flipped, setFlipped] = useState(false);
    const [restartDialogOpen, setRestartDialogOpen] = useState(false);
    const [online, setOnline] = useState(true);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardMoveError, setKeyboardMoveError] = useState<string | null>(
        null
    );
    const [resumableSession, setResumableSession] =
        useState<CoachSessionSnapshot | null>(null);
    const [sessionLoaded, setSessionLoaded] = useState(false);
    const [loadedOwnerKey, setLoadedOwnerKey] =
        useState<string | null>(null);
    const [offlineAssetsReady, setOfflineAssetsReady] = useState(false);

    const gameRef = useRef(new Chess());
    const movesRef = useRef<PlayedMove[]>([]);
    const positionFensRef = useRef<string[]>([START_FEN]);
    const generationRef = useRef(0);
    const sessionKeyRef = useRef(sessionKey());
    const ownerIdRef = useRef(ownerId ?? 'local');
    const activeOpponentRef = useRef<OpponentProfileId>('club');
    const activeOpponentModelRef =
        useRef<CoachOpponentModelId>('stockfish');
    const activeOpponentEloRef = useRef<number | null>(null);
    const activeOpponentEngineRevisionRef = useRef(
        STOCKFISH_OPPONENT_REVISION
    );
    const activeTacticalGuardCpRef = useRef<number | null>(null);
    const activeThresholdCpRef = useRef(COACH_THRESHOLD_DEFAULT_CP);
    const userColorRef = useRef<'w' | 'b'>('w');
    const pendingDecisionRef = useRef<CoachPendingDecision | null>(null);
    const lastSnapshotRef = useRef<CoachSessionSnapshot | null>(null);
    const completedAtRef = useRef<string | null>(null);
    const {
        client: engineClient,
        status: engineWarmup,
        ensure: ensureEngine,
        prepare: prepareEngine,
        analyze: analyzeWithEngine,
        cancelSearch,
        terminate: terminateEngine,
    } = useCoachEngine();
    const {
        status: maiaStatus,
        initialize: initializeMaia,
        selectMove: selectMaiaMove,
        reset: resetMaia,
        removeOfflineData: removeMaiaOfflineData,
        installStatus: maiaInstallStatus,
    } = useMaiaOpponent();

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
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const resolvedOwnerId = resolveCoachOwnerId(ownerId);
        ownerIdRef.current = resolvedOwnerId;
        const ownerKey = ownerId ?? '__offline__';
        const persistenceReady = ownerId
            ? allowCoachSessionPersistence(resolvedOwnerId)
            : Promise.resolve();
        void persistenceReady
            .then(() => loadCoachSession(resolvedOwnerId))
            .then((snapshot) => {
                if (cancelled) return;
                setResumableSession(snapshot);
                setSessionLoaded(true);
                setLoadedOwnerKey(ownerKey);
                if (snapshot) {
                    setOpponentModel(snapshot.opponentModel);
                    setOpponentId(snapshot.opponentId);
                    setThresholdCp(snapshot.thresholdCp);
                    if (snapshot.opponentElo != null) {
                        setMaiaElo(snapshot.opponentElo);
                    }
                    if (snapshot.tacticalGuardCp != null) {
                        setTacticalGuardCp(snapshot.tacticalGuardCp);
                    }
                }
            });
        try {
            const saved = window.localStorage.getItem(
                'backranq.coach.thresholdCp'
            );
            if (saved != null) {
                setThresholdCp(normalizeCoachThresholdCp(saved));
            }
            const savedGuard = window.localStorage.getItem(
                'backranq.coach.maiaTacticalGuardCp'
            );
            if (savedGuard != null) {
                setTacticalGuardCp(
                    normalizeMaiaTacticalGuardCp(savedGuard)
                );
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
        try {
            window.localStorage.setItem(
                'backranq.coach.maiaTacticalGuardCp',
                String(tacticalGuardCp)
            );
        } catch {
            // Preference persistence is best-effort.
        }
    }, [tacticalGuardCp]);

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
        if (
            phase !== 'setup' ||
            !isMaiaOpponentModel(opponentModel) ||
            maiaStatus.phase !== 'idle'
        ) {
            return;
        }
        void initializeMaia(true);
    }, [
        initializeMaia,
        maiaStatus.phase,
        opponentModel,
        phase,
    ]);

    useEffect(() => {
        const persistedPhase: CoachResumablePhase | 'gameover' | null =
            phase === 'analysis'
                ? 'mistake'
                : phase === 'preparing' ||
                    phase === 'player' ||
                    phase === 'checking' ||
                    phase === 'confirming' ||
                    phase === 'bot' ||
                    phase === 'mistake'
                  ? phase
                  : phase === 'gameover'
                    ? 'gameover'
                  : null;
        if (!persistedPhase) return;
        const completedAt =
            persistedPhase === 'gameover'
                ? (completedAtRef.current ?? new Date().toISOString())
                : null;
        if (completedAt) completedAtRef.current = completedAt;
        const snapshotBase = {
            version: 4 as const,
            sessionKey: sessionKeyRef.current,
            ownerId: ownerIdRef.current,
            savedAt: Date.now(),
            userColor: userColorRef.current,
            opponentModel: activeOpponentModelRef.current,
            opponentId: activeOpponentRef.current,
            opponentElo: activeOpponentEloRef.current,
            opponentEngineRevision:
                activeOpponentEngineRevisionRef.current,
            tacticalGuardCp: activeTacticalGuardCpRef.current,
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
        const snapshot: CoachSessionSnapshot =
            persistedPhase === 'gameover'
                ? {
                      ...snapshotBase,
                      phase: 'gameover',
                      completedAt: completedAt!,
                  }
                : { ...snapshotBase, phase: persistedPhase };
        lastSnapshotRef.current = snapshot;
        const generation = generationRef.current;
        const timeout = window.setTimeout(() => {
            if (
                generationRef.current !== generation ||
                sessionKeyRef.current !== snapshot.sessionKey
            ) {
                return;
            }
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
                rootMoves?: readonly string[];
            }
        ) => {
            const result = await analyzeWithEngine({
                fen,
                nodes: options.nodes,
                multiPv: options.multiPv,
                rootMoves: options.rootMoves,
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
        completedAtRef.current ??= new Date().toISOString();
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
                const checkpoint: CoachSessionSnapshot = {
                    version: 4,
                    sessionKey: sessionKeyRef.current,
                    ownerId: ownerIdRef.current,
                    savedAt: Date.now(),
                    phase: 'player',
                    userColor: userColorRef.current,
                    opponentModel: activeOpponentModelRef.current,
                    opponentId: activeOpponentRef.current,
                    opponentElo: activeOpponentEloRef.current,
                    opponentEngineRevision:
                        activeOpponentEngineRevisionRef.current,
                    tacticalGuardCp:
                        activeTacticalGuardCpRef.current,
                    thresholdCp: activeThresholdCpRef.current,
                    gameFen: gameRef.current.fen(),
                    moves: movesRef.current,
                    positionFens: positionFensRef.current,
                    baseline: analysis,
                    pendingDecision: null,
                    mistake: null,
                    mistakes,
                    flipped,
                };
                lastSnapshotRef.current = checkpoint;
                await saveCoachSession(checkpoint);
                if (generationRef.current !== generation) return;
                setBaseline(analysis);
                setPhase('player');
            } catch (error) {
                failEngine(error, generation);
            }
        },
        [
            analyzePosition,
            failEngine,
            finishGame,
            flipped,
            mistakes,
            setPhase,
        ]
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
        async (
            fen: string,
            generation: number,
            verifiedPositionAnalysis?: MultiPvResult | null
        ) => {
            if (generationRef.current !== generation) return;
            setPhase('bot');
            const activeModel = activeOpponentModelRef.current;
            if (isMaiaOpponentModel(activeModel)) {
                try {
                    const seed = deriveMaiaOpponentSeed(
                        sessionKeyRef.current,
                        movesRef.current.length
                    );
                    const selected = await selectMaiaMove({
                        fen,
                        selfElo:
                            activeOpponentEloRef.current ??
                            MAIA_OPPONENT_DEFAULT_ELO,
                        opponentElo:
                            activeOpponentEloRef.current ??
                            MAIA_OPPONENT_DEFAULT_ELO,
                        seed,
                    });
                    if (generationRef.current !== generation) return;
                    if (
                        selected.engineRevision !==
                            MAIA_MODEL.engineRevision ||
                        selected.modelId !== MAIA_MODEL.id ||
                        selected.samplerVersion !==
                            MAIA_MODEL.samplerVersion ||
                        selected.seed !== seed
                    ) {
                        throw new Error(
                            'The loaded Maia model or sampler does not match this game.'
                        );
                    }
                    let selectedMoveUci = selected.moveUci;
                    if (isMaiaTacticalGuardModel(activeModel)) {
                        if (selected.candidates.length === 0) {
                            throw new Error(
                                'Maia returned no candidates for tactical verification.'
                            );
                        }
                        const maiaCandidates =
                            selected.candidates.slice(
                                0,
                                MAIA_TACTICAL_GUARD_CANDIDATES
                            );
                        const verifiedBestLine =
                            verifiedPositionAnalysis?.fen === fen
                                ? verifiedPositionAnalysis.lines
                                      .slice()
                                      .sort(
                                          (left, right) =>
                                              left.multipv -
                                              right.multipv
                                      )[0]
                                : undefined;
                        const seedAnalysis =
                            verifiedBestLine?.nodes != null &&
                            verifiedBestLine.nodes >=
                                MAIA_TACTICAL_GUARD_NODES
                                ? verifiedPositionAnalysis!
                                : await analyzePosition(
                                      fen,
                                      generation,
                                      {
                                          nodes: MAIA_TACTICAL_GUARD_NODES,
                                          multiPv: 1,
                                      }
                                  );
                        const stockfishSeed = seedAnalysis.lines
                            .slice()
                            .sort(
                                (left, right) =>
                                    left.multipv - right.multipv
                            )[0]?.pvUci[0]
                            ?.trim()
                            .toLowerCase();
                        if (!stockfishSeed) {
                            throw new Error(
                                'Stockfish returned no tactical fallback.'
                            );
                        }
                        const rootMoves = Array.from(
                            new Set([
                                ...maiaCandidates.map((candidate) =>
                                    candidate.moveUci
                                        .trim()
                                        .toLowerCase()
                                ),
                                stockfishSeed,
                            ])
                        );
                        const guardedAnalysis = await analyzePosition(
                            fen,
                            generation,
                            {
                                nodes: MAIA_TACTICAL_GUARD_NODES,
                                multiPv: rootMoves.length,
                                rootMoves,
                            }
                        );
                        if (
                            !isStructurallyCompleteMultiPvBundle(
                                guardedAnalysis.lines,
                                rootMoves.length
                            )
                        ) {
                            throw new Error(
                                'Stockfish could not verify every tactical candidate.'
                            );
                        }
                        selectedMoveUci = selectTacticalGuardMove({
                            maiaCandidates,
                            analysis: guardedAnalysis,
                            thresholdCp:
                                activeTacticalGuardCpRef.current ??
                                MAIA_TACTICAL_GUARD_DEFAULT_CP,
                            seed,
                        }).moveUci;
                    }
                    const parsed = parseUci(selectedMoveUci);
                    if (!parsed) {
                        throw new Error(
                            'Maia returned an invalid move.'
                        );
                    }
                    const fenBefore = gameRef.current.fen();
                    const move = gameRef.current.move({
                        from: parsed.from,
                        to: parsed.to,
                        promotion: parsed.promotion,
                    });
                    if (!move) {
                        throw new Error(
                            'Maia returned an illegal move.'
                        );
                    }
                    appendMove(move, 'bot', fenBefore);
                    if (finishGame()) return;
                    await preparePlayerTurn(
                        gameRef.current.fen(),
                        generation
                    );
                } catch (error) {
                    if (generationRef.current !== generation) return;
                    const message =
                        error instanceof Error
                            ? error.message
                            : String(error);
                    setEngineError(
                        `The Maia opponent could not finish its move. ${message}`
                    );
                    setPhase('error');
                }
                return;
            }
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
        [
            analyzePosition,
            appendMove,
            failEngine,
            finishGame,
            playOpponentFromAnalysis,
            preparePlayerTurn,
            selectMaiaMove,
            setPhase,
        ]
    );

    const startGame = useCallback(async () => {
        if (engineWarmup !== 'ready') {
            void warmUpEngine();
            return;
        }
        if (
            isMaiaOpponentModel(opponentModel) &&
            maiaStatus.phase !== 'ready'
        ) {
            void initializeMaia(true);
            return;
        }
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        cancelSearch();
        lastSnapshotRef.current = null;
        sessionKeyRef.current = sessionKey();
        ownerIdRef.current =
            ownerId ?? ownerIdRef.current;
        activeOpponentModelRef.current = opponentModel;
        activeOpponentRef.current = opponentId;
        activeOpponentEloRef.current =
            isMaiaOpponentModel(opponentModel)
                ? normalizeMaiaOpponentElo(maiaElo)
                : null;
        activeOpponentEngineRevisionRef.current =
            coachOpponentEngineRevision(opponentModel);
        activeTacticalGuardCpRef.current =
            isMaiaTacticalGuardModel(opponentModel)
                ? normalizeMaiaTacticalGuardCp(tacticalGuardCp)
                : null;
        activeThresholdCpRef.current =
            normalizeCoachThresholdCp(thresholdCp);
        pendingDecisionRef.current = null;
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
        completedAtRef.current = null;
        setCompletedGameStatus('idle');
        setCompletedGameError(null);
        setEngineError(null);
        setSelectedSquare(null);
        setPendingPromotion(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        setFlipped(false);
        setPhase('starting');
        await clearCoachSession(ownerIdRef.current);
        if (generationRef.current !== generation) return;
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
        engineWarmup,
        ensureEngine,
        failEngine,
        initializeMaia,
        maiaElo,
        maiaStatus.phase,
        opponentId,
        opponentModel,
        ownerId,
        playOpponentTurn,
        preparePlayerTurn,
        setPhase,
        thresholdCp,
        tacticalGuardCp,
        warmUpEngine,
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
                await playOpponentTurn(
                    record.fenAfter,
                    generation,
                    verifiedAfterAnalysis
                );
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
                version: 4,
                sessionKey: sessionKeyRef.current,
                ownerId: ownerIdRef.current,
                savedAt: Date.now(),
                phase: 'checking',
                userColor: userColorRef.current,
                opponentModel: activeOpponentModelRef.current,
                opponentId: activeOpponentRef.current,
                opponentElo: activeOpponentEloRef.current,
                opponentEngineRevision:
                    activeOpponentEngineRevisionRef.current,
                tacticalGuardCp:
                    activeTacticalGuardCpRef.current,
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
            generationRef.current,
            mistake.afterAnalysis
        );
    }, [finishGame, mistake, playOpponentTurn]);

    const resumeCoachSession = useCallback(
        async (
            snapshot: CoachSessionSnapshot,
            maiaReadyOverride?: boolean
        ) => {
            const maiaReady =
                maiaReadyOverride ?? maiaStatus.phase === 'ready';
            if (
                snapshot.phase !== 'gameover' &&
                isMaiaOpponentModel(snapshot.opponentModel) &&
                !maiaReady
            ) {
                setEngineError(
                    'Maia is still being prepared. Continue once the opponent is ready.'
                );
                return;
            }
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
            activeOpponentModelRef.current =
                snapshot.opponentModel;
            activeOpponentEloRef.current = snapshot.opponentElo;
            activeOpponentEngineRevisionRef.current =
                snapshot.opponentEngineRevision;
            activeTacticalGuardCpRef.current =
                snapshot.tacticalGuardCp;
            activeThresholdCpRef.current = snapshot.thresholdCp;
            userColorRef.current = snapshot.userColor;
            pendingDecisionRef.current = snapshot.pendingDecision;
            gameRef.current = restored;
            movesRef.current = snapshot.moves;
            positionFensRef.current = snapshot.positionFens;
            lastSnapshotRef.current = snapshot;
            setUserColor(snapshot.userColor);
            if (!isMaiaOpponentModel(snapshot.opponentModel)) {
                resetMaia();
            }
            setOpponentModel(snapshot.opponentModel);
            setOpponentId(snapshot.opponentId);
            if (snapshot.opponentElo != null) {
                setMaiaElo(snapshot.opponentElo);
            }
            if (snapshot.tacticalGuardCp != null) {
                setTacticalGuardCp(snapshot.tacticalGuardCp);
            }
            setThresholdCp(snapshot.thresholdCp);
            setGameFen(restored.fen());
            setMoves(snapshot.moves);
            setBaseline(snapshot.baseline);
            setMistake(snapshot.mistake);
            setMistakes(snapshot.mistakes);
            setOutcome(
                snapshot.phase === 'gameover'
                    ? getCoachGameOutcome(restored, snapshot.userColor)
                    : null
            );
            setSelectedSquare(null);
            setPendingPromotion(null);
            setKeyboardMove('');
            setKeyboardMoveError(null);
            setFlipped(snapshot.flipped);
            setResumableSession(null);

            if (snapshot.phase === 'gameover') {
                completedAtRef.current = snapshot.completedAt;
                setCompletedGameStatus('idle');
                setCompletedGameError(null);
                terminateEngine('idle');
                setPhase('gameover');
                return;
            }

            try {
                const expectedOpponentRevision =
                    coachOpponentEngineRevision(
                        snapshot.opponentModel
                    );
                if (
                    !isCompatibleCoachOpponentRevision(
                        snapshot.opponentModel,
                        snapshot.opponentEngineRevision
                    )
                ) {
                    throw new Error(
                        `This game requires ${snapshot.opponentEngineRevision}, but this app provides ${expectedOpponentRevision}. The opponent cannot be changed during a game.`
                    );
                }
                const [judgeReady, opponentReady] =
                    await Promise.all([
                        prepareEngine(),
                        isMaiaOpponentModel(snapshot.opponentModel)
                            ? Promise.resolve(maiaReady)
                            : Promise.resolve(true),
                    ]);
                if (!judgeReady) {
                    throw new Error(
                        'The Stockfish judge could not restart.'
                    );
                }
                if (!opponentReady) {
                    throw new Error(
                        'The saved Maia opponent could not be loaded.'
                    );
                }
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
            } catch (error) {
                terminateEngine('error');
                setEngineError(
                    `${
                        error instanceof Error
                            ? error.message
                            : 'The local game components could not be restarted.'
                    } Your game remains saved on this device.`
                );
                setPhase('error');
            }
        },
        [
            checkPlayerMove,
            cancelSearch,
            maiaStatus.phase,
            playOpponentTurn,
            prepareEngine,
            preparePlayerTurn,
            resetMaia,
            setPhase,
            terminateEngine,
        ]
    );

    const recoverEngine = useCallback(async () => {
        const snapshot =
            lastSnapshotRef.current ?? resumableSession;
        if (!snapshot) {
            setEngineError(
                'No valid local checkpoint is available for recovery.'
            );
            return;
        }
        const recoveryGeneration = generationRef.current;
        terminateEngine('idle');
        if (isMaiaOpponentModel(snapshot.opponentModel)) {
            resetMaia();
            setEngineError(null);
            setPhase('recovering');
            const ready = await initializeMaia(true);
            if (
                generationRef.current !== recoveryGeneration
            ) {
                return;
            }
            if (!ready) {
                setEngineError(
                    'The Maia opponent could not be restarted. Return to setup and retry its preparation.'
                );
                setPhase('error');
                return;
            }
        }
        if (generationRef.current !== recoveryGeneration) {
            return;
        }
        await resumeCoachSession(
            snapshot,
            isMaiaOpponentModel(snapshot.opponentModel)
                ? true
                : undefined
        );
    }, [
        initializeMaia,
        resetMaia,
        resumableSession,
        resumeCoachSession,
        setPhase,
        terminateEngine,
    ]);

    const changeOpponentModel = useCallback(
        (nextModel: CoachOpponentModelId) => {
            if (
                !isMaiaOpponentModel(nextModel) &&
                isMaiaOpponentModel(opponentModel)
            ) {
                resetMaia();
            }
            setOpponentModel(nextModel);
        },
        [opponentModel, resetMaia]
    );

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
        completedAtRef.current = null;
        setCompletedGameStatus('idle');
        setCompletedGameError(null);
        pendingDecisionRef.current = null;
        lastSnapshotRef.current = null;
        void clearCoachSession(ownerIdRef.current);
        setResumableSession(null);
        setPhase('setup');
        setRestartDialogOpen(false);
    }, [cancelSearch, phase, setPhase, terminateEngine]);

    const saveAndAnalyzeCompletedGame = useCallback(async () => {
        if (
            !ownerId ||
            phase !== 'gameover' ||
            completedGameStatus === 'saving' ||
            completedGameStatus === 'analyzing' ||
            completedGameStatus === 'saved'
        ) {
            return;
        }
        const completedAt =
            completedAtRef.current ?? new Date().toISOString();
        completedAtRef.current = completedAt;
        setCompletedGameStatus('saving');
        setCompletedGameError(null);
        try {
            const saved = await saveCompletedCoachGameAndAnalyze({
                ownerId,
                game: gameRef.current,
                sessionId: sessionKeyRef.current,
                userSide: userColorRef.current,
                completedAt,
            });
            lastSnapshotRef.current = null;
            setResumableSession(null);
            await clearCoachSession(ownerIdRef.current);
            setCompletedGameStatus(
                saved.needsAnalysis ? 'analyzing' : 'saved'
            );
        } catch (error) {
            setCompletedGameStatus('error');
            setCompletedGameError(
                error instanceof Error
                    ? error.message
                    : 'The completed game could not be saved.'
            );
        }
    }, [completedGameStatus, ownerId, phase]);

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
    const coachMarkerSquare =
        phase === 'mistake' && lastMove ? lastMove.to : null;
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
    const normalizedTacticalGuardCp =
        normalizeMaiaTacticalGuardCp(tacticalGuardCp);
    const ownerSessionIsCurrent =
        loadedOwnerKey === (ownerId ?? '__offline__');

    if (phase === 'setup') {
        return (
            <CoachSetup
                colorChoice={colorChoice}
                engineError={engineError}
                engineWarmup={engineWarmup}
                maiaElo={maiaElo}
                maiaError={
                    maiaStatus.phase === 'error'
                        ? maiaStatus.message
                        : null
                }
                maiaModelBytes={MAIA_MODEL.byteLength}
                maiaDownloadMiB={MAIA_MODEL.estimatedDownloadMiB}
                maiaModelLabel={`${MAIA_MODEL.displayName} · simplified browser model · ${MAIA_MODEL.version}`}
                maiaModelLicenseStatus={MAIA_MODEL.licenseStatus}
                maiaModelProjectUrl={MAIA_MODEL.upstreamProject}
                maiaModelProvenance={`CSSLab · source ${MAIA_MODEL.sourceCommit.slice(
                    0,
                    8
                )}`}
                maiaModelSourceUrl={MAIA_MODEL.sourceUrl}
                maiaHasStoredData={
                    maiaInstallStatus.hasStoredData
                }
                maiaInstalled={maiaInstallStatus.installed}
                maiaInstallChecking={
                    maiaInstallStatus.checking
                }
                maiaOfflineReady={
                    maiaStatus.offlineReady === true
                }
                maiaPhase={maiaStatus.phase}
                maiaProgress={maiaStatus.progress}
                normalizedTacticalGuardCp={
                    normalizedTacticalGuardCp
                }
                normalizedThresholdCp={normalizedThresholdCp}
                offlineAssetsReady={offlineAssetsReady}
                opponentId={opponentId}
                opponentModel={opponentModel}
                resumableSession={
                    ownerSessionIsCurrent
                        ? resumableSession
                        : null
                }
                sessionLoaded={
                    ownerSessionIsCurrent && sessionLoaded
                }
                thresholdCp={thresholdCp}
                tacticalGuardCp={tacticalGuardCp}
                onColorChoiceChange={setColorChoice}
                onDiscardSession={() => {
                    void clearCoachSession(
                        resumableSession?.ownerId ??
                            ownerIdRef.current
                    );
                    setResumableSession(null);
                }}
                onMaiaEloChange={setMaiaElo}
                onOpponentChange={setOpponentId}
                onOpponentModelChange={changeOpponentModel}
                onResume={(snapshot) => void resumeCoachSession(snapshot)}
                onRetryEngine={() => void warmUpEngine()}
                onRetryMaia={() => void initializeMaia(true, true)}
                onRemoveMaia={async () => {
                    const error = await removeMaiaOfflineData();
                    if (!error) {
                        setOpponentModel('stockfish');
                    }
                    return error;
                }}
                onStart={startGame}
                onThresholdChange={setThresholdCp}
                onTacticalGuardChange={setTacticalGuardCp}
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
                    persistDraft={false}
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
                        {isMaiaOpponentModel(
                            activeOpponentModelRef.current
                        )
                            ? `${isMaiaTacticalGuardModel(activeOpponentModelRef.current) ? 'Maia + tactical guard' : 'Maia 3'} · ${activeOpponentEloRef.current} Elo`
                            : `Stockfish · ${getOpponentProfile(activeOpponentRef.current).label}`}{' '}
                        · coach at {activeThresholdCpRef.current} cp
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
                        {online
                            ? 'Local judge · local opponent'
                            : 'Offline · local judge and opponent'}
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
                            'relative max-w-full overflow-hidden rounded-xl border bg-card p-1 shadow-sm transition-colors sm:p-2',
                            phase === 'mistake' &&
                                'border-red-500/50 ring-2 ring-red-500/10'
                        )}
                        role="group"
                        aria-label="Coach game board"
                        data-coach-board
                        data-coach-last-move={
                            lastMove
                                ? `${lastMove.from}${lastMove.to}`
                                : undefined
                        }
                        data-coach-marker-square={
                            coachMarkerSquare ?? undefined
                        }
                        aria-busy={
                            phase === 'starting' ||
                            phase === 'preparing' ||
                            phase === 'checking' ||
                            phase === 'confirming' ||
                            phase === 'recovering' ||
                            phase === 'bot'
                        }
                    >
                        <div className="relative aspect-square w-full touch-manipulation">
                            <Chessboard
                                options={{
                                    position: gameFen,
                                    boardOrientation:
                                        (userColor === 'w') !== flipped
                                            ? 'white'
                                            : 'black',
                                    allowDragging: canMove,
                                    allowDrawingArrows: false,
                                    showAnimations: !reducedMotion,
                                    animationDurationInMs: reducedMotion
                                        ? 0
                                        : 180,
                                    squareStyles,
                                    squareRenderer: ({ square, children }) => (
                                        <div className="relative h-full w-full">
                                            {children}
                                            {coachMarkerSquare === square ? (
                                                <span
                                                    className="pointer-events-none absolute right-[5%] top-[5%] z-20 flex h-[28%] min-h-5 min-w-5 items-center justify-center rounded-full border border-red-100 bg-red-500 text-[clamp(11px,2.8vw,17px)] font-black leading-none text-white shadow-lg shadow-red-950/25 animate-in fade-in zoom-in-75 duration-200 motion-reduce:animate-none"
                                                    role="img"
                                                    aria-label={`Coach pause on ${square}`}
                                                    data-coach-move-quality="mistake"
                                                >
                                                    !
                                                </span>
                                            ) : null}
                                        </div>
                                    ),
                                    canDragPiece: ({ square }) => {
                                        if (!canMove || !square) return false;
                                        return (
                                            gameRef.current.get(
                                                square as Square
                                            )?.color === userColor
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
                                        if (!targetSquare || !canMove) {
                                            return false;
                                        }
                                        return playOrChoosePromotion(
                                            sourceSquare as Square,
                                            targetSquare as Square
                                        );
                                    },
                                }}
                            />
                            <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex justify-center sm:inset-x-3 sm:bottom-3">
                                <div
                                    className={cn(
                                        'flex max-w-[92%] items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold shadow-xl backdrop-blur-md sm:text-sm',
                                        'animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
                                        phase === 'mistake'
                                            ? 'border-red-200/80 bg-red-950/88 text-red-50'
                                            : phase === 'error'
                                              ? 'border-red-200/80 bg-red-950/88 text-red-50'
                                              : 'border-white/20 bg-zinc-950/82 text-white'
                                    )}
                                    role="status"
                                    aria-live="polite"
                                    aria-atomic="true"
                                    data-coach-board-status={phase}
                                >
                                    {phase === 'starting' ||
                                    phase === 'preparing' ||
                                    phase === 'checking' ||
                                    phase === 'confirming' ||
                                    phase === 'recovering' ||
                                    phase === 'bot' ? (
                                        <Loader2
                                            className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                                            aria-hidden="true"
                                        />
                                    ) : phase === 'mistake' ? (
                                        <AlertTriangle
                                            className="h-3.5 w-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                    ) : phase === 'gameover' ? (
                                        <CheckCircle2
                                            className="h-3.5 w-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Brain
                                            className="h-3.5 w-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                    )}
                                    <span className="truncate">
                                        {phaseMessage(
                                            phase,
                                            userColor,
                                            activeOpponentModelRef.current
                                        )}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {phase === 'mistake' && mistake ? (
                        <>
                            <div
                                className="sticky bottom-[calc(var(--app-bottom-nav-height)+env(safe-area-inset-bottom)+0.5rem)] z-30 mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-red-500/25 bg-background/[0.92] p-2 shadow-lg backdrop-blur lg:hidden"
                                role="group"
                                aria-label="Coach pause actions"
                            >
                                <Button
                                    type="button"
                                    onClick={retryMistake}
                                    aria-label="Try again"
                                >
                                    <RotateCcw aria-hidden="true" />
                                    <span className="hidden sm:inline">
                                        Try again
                                    </span>
                                    <span className="sm:hidden">Retry</span>
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => setPhase('analysis')}
                                >
                                    <Brain aria-hidden="true" />
                                    Analyze
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={continueAfterMistake}
                                >
                                    Continue
                                </Button>
                            </div>
                            <CoachInterventionCard
                                className="mt-3 lg:hidden"
                                mistake={mistake}
                                thresholdCp={activeThresholdCpRef.current}
                                onAnalyze={() => setPhase('analysis')}
                                onContinue={continueAfterMistake}
                                onRetry={retryMistake}
                                showActions={false}
                            />
                        </>
                    ) : null}
                </div>

                <div className="min-w-0 space-y-4">
                    {phase === 'mistake' && mistake ? (
                        <CoachInterventionCard
                            className="hidden lg:block"
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
                                {ownerId ? (
                                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                                        <Button
                                            type="button"
                                            disabled={
                                                completedGameStatus === 'saving' ||
                                                completedGameStatus === 'analyzing' ||
                                                completedGameStatus === 'saved'
                                            }
                                            onClick={() =>
                                                void saveAndAnalyzeCompletedGame()
                                            }
                                        >
                                            {completedGameStatus === 'saving' ? (
                                                <Loader2
                                                    className="mr-2 h-4 w-4 animate-spin"
                                                    aria-hidden="true"
                                                />
                                            ) : completedGameStatus === 'analyzing' ||
                                              completedGameStatus === 'saved' ? (
                                                <CheckCircle2
                                                    className="mr-2 h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                            ) : (
                                                <Brain
                                                    className="mr-2 h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            {completedGameStatus === 'saving'
                                                ? 'Saving game…'
                                                : completedGameStatus === 'analyzing'
                                                  ? 'Saved · browser analysis started'
                                                  : completedGameStatus === 'saved'
                                                    ? 'Already saved'
                                                    : completedGameStatus === 'error'
                                                      ? 'Retry save & analyze'
                                                      : 'Save & analyze for Practice'}
                                        </Button>
                                        <p className="text-xs text-muted-foreground">
                                            The completed game stays saved on this
                                            device until the server accepts it or you
                                            explicitly discard it.
                                        </p>
                                        {completedGameError ? (
                                            <p
                                                className="text-sm text-destructive"
                                                role="alert"
                                            >
                                                {completedGameError}
                                            </p>
                                        ) : completedGameStatus === 'analyzing' ? (
                                            <p
                                                className="text-sm text-emerald-700 dark:text-emerald-400"
                                                role="status"
                                            >
                                                Browser analysis has started. Keep this
                                                tab open until it finishes.
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                                <div className="flex flex-wrap gap-2">
                                    <Button type="button" onClick={startGame}>
                                        {completedGameStatus === 'analyzing' ||
                                        completedGameStatus === 'saved'
                                            ? 'Rematch'
                                            : 'Discard & rematch'}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={returnToSetup}
                                    >
                                        {completedGameStatus === 'analyzing' ||
                                        completedGameStatus === 'saved'
                                            ? 'Change setup'
                                            : 'Discard & change setup'}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ) : null}

                    {phase === 'error' ? (
                        <Card className="border-destructive/35">
                            <CardHeader>
                                <CardTitle className="text-base">
                                    Local game component interrupted
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
                                    Restart and resume
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
                                    Recovery reloads the locked opponent,
                                    replays the saved UCI moves and reruns the
                                    interrupted local task. No move is applied
                                    twice.
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
                                {isMaiaOpponentModel(
                                    activeOpponentModelRef.current
                                )
                                    ? `${isMaiaTacticalGuardModel(activeOpponentModelRef.current) ? 'Maia + tactical guard' : 'Maia 3'} · ${activeOpponentEloRef.current} Elo${activeTacticalGuardCpRef.current == null ? '' : ` · guard at ${activeTacticalGuardCpRef.current} cp`}`
                                    : `Stockfish · ${
                                          getOpponentProfile(
                                              activeOpponentRef.current
                                          ).label
                                      }`}{' '}
                                · stop at ≥{' '}
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
