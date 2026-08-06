'use client';

import Link from 'next/link';
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import {
    CheckCircle2,
    CircleAlert,
    Loader2,
    Search,
    Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import {
    fetchCurrentMasterPuzzle,
    fetchOnboardingGames,
    OnboardingClientError,
    recordOnboardingEvent,
} from '@/lib/onboarding/client';
import type {
    OnboardingAnalysisProgress,
    OnboardingSearchError,
    PublicChessIdentity,
    PublicChessProvider,
} from '@/lib/onboarding/contracts';
import { findFirstVerifiedPersonalPuzzle } from '@/lib/onboarding/personalPuzzleFinder';
import { landingOnboardingReducer } from '@/lib/onboarding/state';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';

import { PublicPuzzlePlayer } from './PublicPuzzlePlayer';

const SESSION_KEY = 'backranq:onboarding-session-v1';

function sessionId() {
    try {
        const current = window.sessionStorage.getItem(SESSION_KEY);
        if (current) return current;
        const created = crypto.randomUUID();
        window.sessionStorage.setItem(SESSION_KEY, created);
        return created;
    } catch {
        return crypto.randomUUID();
    }
}

function errorCopy(reason: OnboardingSearchError) {
    switch (reason) {
        case 'PROFILE_NOT_FOUND':
            return 'We could not find that public profile. Check the spelling and provider.';
        case 'PROVIDER_RATE_LIMITED':
            return 'The chess provider is busy right now. Keep solving and try again shortly.';
        case 'PROVIDER_UNAVAILABLE':
            return 'That provider is temporarily unavailable. The puzzle on the board still works.';
        case 'ENGINE_UNAVAILABLE':
            return 'Analysis could not start in this browser. The puzzle on the board still works.';
        case 'OFFLINE':
            return 'You appear to be offline. Reconnect and try again when you are ready.';
        case 'INVALID_USERNAME':
            return 'Enter a valid public username.';
        default:
            return 'We could not prepare a personal position this time. You can keep solving this one.';
    }
}

function analysisPercent(progress: OnboardingAnalysisProgress) {
    const gameShare = 100 / Math.max(1, progress.gameCount);
    const withinGame = progress.plyCount
        ? Math.min(1, progress.ply / progress.plyCount)
        : 0;
    return Math.min(
        99,
        Math.round(progress.gameIndex * gameShare + withinGame * gameShare)
    );
}

export function DualOnboardingHero({ isSignedIn }: { isSignedIn: boolean }) {
    const [state, dispatch] = useReducer(landingOnboardingReducer, {
        activePuzzle: WARMUP_PUZZLE,
        masterTerminal: false,
        personal: { status: 'IDLE' },
        handoff: 'HIDDEN',
    });
    const [provider, setProvider] =
        useState<PublicChessProvider>('lichess');
    const [username, setUsername] = useState('');
    const [validationError, setValidationError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const engineRef = useRef<StockfishClient | null>(null);
    const introAttemptStartedRef = useRef(false);
    const terminalStateRef = useRef(false);
    const startedPuzzleIdsRef = useRef(new Set<string>());
    const mountedRef = useRef(true);
    const sessionIdRef = useRef<string | null>(null);
    const milestonesRef = useRef(new Set<number>());

    const emit = useCallback(
        (
            eventName: Parameters<typeof recordOnboardingEvent>[0]['eventName'],
            fields: Omit<
                Parameters<typeof recordOnboardingEvent>[0],
                'eventName' | 'eventId' | 'sessionId' | 'occurredAt'
            > = {}
        ) => {
            const id = sessionIdRef.current ?? sessionId();
            sessionIdRef.current = id;
            void recordOnboardingEvent({
                eventName,
                eventId: crypto.randomUUID(),
                sessionId: id,
                occurredAt: new Date().toISOString(),
                ...fields,
            });
        },
        []
    );

    useEffect(() => {
        mountedRef.current = true;
        sessionIdRef.current = sessionId();
        emit('LANDING_VIEWED');
        void fetchCurrentMasterPuzzle().then((puzzle) => {
            if (!mountedRef.current) return;
            if (!introAttemptStartedRef.current) {
                dispatch({ type: 'RESET_MASTER', puzzle });
                if (puzzle.context.kind === 'MASTER') {
                    emit('MASTER_PUZZLE_SHOWN');
                }
            }
        });
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
            engineRef.current?.terminate?.();
        };
    }, [emit]);

    const reportProgress = useCallback(
        (runId: string, progress: OnboardingAnalysisProgress) => {
            dispatch({ type: 'ANALYSIS_PROGRESS', runId, progress });
            const percent = analysisPercent(progress);
            for (const milestone of [25, 50, 75] as const) {
                if (
                    percent >= milestone &&
                    !milestonesRef.current.has(milestone)
                ) {
                    milestonesRef.current.add(milestone);
                    emit('PERSONAL_ANALYSIS_MILESTONE', {
                        runId,
                        provider,
                        gameCount: progress.gameCount,
                        gameIndex: progress.gameIndex,
                        progressMilestone: milestone,
                    });
                }
            }
        },
        [emit, provider]
    );

    const submitIdentity = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const normalizedUsername = username.trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(normalizedUsername)) {
            setValidationError('Enter a public username using letters, numbers, _ or -.');
            return;
        }
        setValidationError(null);
        abortRef.current?.abort();
        engineRef.current?.terminate?.();
        const controller = new AbortController();
        abortRef.current = controller;
        const runId = crypto.randomUUID();
        const identity: PublicChessIdentity = {
            provider,
            username: normalizedUsername,
        };
        milestonesRef.current = new Set();
        const startedAt = performance.now();
        let lookupSucceeded = false;
        dispatch({ type: 'SEARCH_STARTED', runId, identity });
        emit('IDENTITY_SUBMITTED', { runId, provider });

        try {
            const response = await fetchOnboardingGames(
                identity,
                controller.signal
            );
            if (controller.signal.aborted) return;
            lookupSucceeded = true;
            emit('IDENTITY_LOOKUP_SUCCEEDED', {
                runId,
                provider,
                gameCount: response.games.length,
            });
            if (response.games.length === 0) {
                dispatch({ type: 'SEARCH_EMPTY', runId, reason: 'NO_GAMES' });
                return;
            }
            dispatch({
                type: 'ANALYSIS_PROGRESS',
                runId,
                progress: {
                    phase: 'ENGINE_STARTING',
                    gameIndex: 0,
                    gameCount: response.games.length,
                    ply: 0,
                    plyCount: 0,
                },
            });
            emit('PERSONAL_ANALYSIS_STARTED', {
                runId,
                provider,
                gameCount: response.games.length,
            });
            const engine = new StockfishClient();
            engineRef.current = engine;
            const puzzle = await findFirstVerifiedPersonalPuzzle({
                games: response.games,
                identity,
                engine,
                signal: controller.signal,
                onProgress: (progress) => reportProgress(runId, progress),
            });
            if (controller.signal.aborted) return;
            if (!puzzle) {
                dispatch({
                    type: 'SEARCH_EMPTY',
                    runId,
                    reason: 'NO_VERIFIED_POSITION',
                });
                return;
            }
            dispatch({ type: 'PERSONAL_READY', runId, puzzle });
            emit('PERSONAL_PUZZLE_READY', {
                runId,
                provider,
                durationMs: Math.round(performance.now() - startedAt),
                masterState: terminalStateRef.current ? 'TERMINAL' : 'SOLVING',
            });
            emit('PERSONAL_READY_NOTICE_SHOWN', {
                runId,
                provider,
                masterState: terminalStateRef.current ? 'TERMINAL' : 'SOLVING',
            });
        } catch (error) {
            if (controller.signal.aborted) return;
            const reason =
                error instanceof OnboardingClientError
                    ? error.reason
                    : error instanceof Error &&
                        /worker|stockfish|engine/i.test(error.message)
                      ? 'ENGINE_UNAVAILABLE'
                      : 'UNKNOWN';
            const retryable =
                error instanceof OnboardingClientError
                    ? error.retryable
                    : reason !== 'UNKNOWN';
            dispatch({ type: 'SEARCH_FAILED', runId, reason, retryable });
            emit(
                lookupSucceeded
                    ? 'PERSONAL_ANALYSIS_FAILED'
                    : 'IDENTITY_LOOKUP_FAILED',
                { runId, provider, reason }
            );
        } finally {
            if (engineRef.current) {
                engineRef.current.terminate?.();
                engineRef.current = null;
            }
        }
    };

    const statusSlot = useMemo(() => {
        const personal = state.personal;
        if (personal.status === 'IDLE') {
            return (
                <Card className="border-dashed">
                    <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground">
                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <p>
                            Enter your username. We will scan recent public games while
                            you solve this position.
                        </p>
                    </CardContent>
                </Card>
            );
        }
        if (personal.status === 'FETCHING') {
            return <WorkingStatus title="Finding your recent games…" />;
        }
        if (personal.status === 'ANALYZING') {
            const percent = analysisPercent(personal.progress);
            return (
                <Card>
                    <CardContent className="space-y-3 p-4" aria-live="polite">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            {personal.progress.phase === 'CONFIRMING'
                                ? 'Verifying a promising decision…'
                                : 'Scanning your recent games…'}
                        </div>
                        <div
                            className="h-2 overflow-hidden rounded-full bg-secondary"
                            role="progressbar"
                            aria-label="Personal game analysis progress"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                        >
                            <div
                                className="h-full rounded-full bg-primary transition-[width]"
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Game {personal.progress.gameIndex + 1} of{' '}
                            {personal.progress.gameCount}. Keep playing—your puzzle will
                            wait for you when it is ready.
                        </p>
                    </CardContent>
                </Card>
            );
        }
        if (personal.status === 'READY') {
            if (state.activePuzzle.context.kind === 'PERSONAL') {
                return (
                    <Card className="border-emerald-500/30 bg-emerald-500/5">
                        <CardContent className="flex gap-3 p-4 text-sm">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                            <p>This position came from one of your public games.</p>
                        </CardContent>
                    </Card>
                );
            }
            return (
                <Card className="border-emerald-500/30 bg-emerald-500/5">
                    <CardContent className="space-y-3 p-4" aria-live="polite">
                        <div className="flex gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-200">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p>Your position is ready. Finish this puzzle first—nothing will interrupt it.</p>
                        </div>
                        {state.handoff === 'OFFERED' ? (
                            <Button
                                type="button"
                                className="w-full"
                                onClick={() => {
                                    dispatch({ type: 'ACCEPT_HANDOFF' });
                                    emit('PERSONAL_HANDOFF_CLICKED', {
                                        runId: personal.runId,
                                        provider: personal.identity.provider,
                                        masterState: 'TERMINAL',
                                    });
                                    emit('PERSONAL_PUZZLE_SHOWN', {
                                        runId: personal.runId,
                                        provider: personal.identity.provider,
                                    });
                                }}
                            >
                                Now solve a position you actually played
                            </Button>
                        ) : null}
                    </CardContent>
                </Card>
            );
        }
        if (personal.status === 'EMPTY') {
            return (
                <NoticeStatus
                    text={
                        personal.reason === 'NO_GAMES'
                            ? 'No recent public games were found. Play a game or try another profile.'
                            : 'We did not find a clear, verified training position in these games. That is better than inventing a blunder.'
                    }
                />
            );
        }
        return <NoticeStatus text={errorCopy(personal.reason)} />;
    }, [emit, state]);

    return (
        <section className="relative overflow-hidden border-b">
            <div
                className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-zinc-200/70 via-transparent to-transparent dark:from-zinc-800/50"
                aria-hidden="true"
            />
            <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(320px,0.78fr)_minmax(0,1.22fr)] lg:items-start lg:gap-14 lg:py-20">
                <div className="lg:sticky lg:top-8">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                        Personal chess practice
                    </p>
                    <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                        Stop solving random puzzles. Practice your decisions.
                    </h1>
                    <p className="mt-5 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
                        Enter a public Chess.com or Lichess username. Backranq finds a
                        real training position from your games—and gives you something
                        worth solving while it works.
                    </p>

                    <form className="mt-8 space-y-3" onSubmit={submitIdentity}>
                        <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                            <label className="sr-only" htmlFor="landing-provider">
                                Chess provider
                            </label>
                            <select
                                id="landing-provider"
                                value={provider}
                                onChange={(event) =>
                                    setProvider(
                                        event.target.value as PublicChessProvider
                                    )
                                }
                                className="h-12 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <option value="lichess">Lichess</option>
                                <option value="chesscom">Chess.com</option>
                            </select>
                            <label className="sr-only" htmlFor="landing-username">
                                Public chess username
                            </label>
                            <Input
                                id="landing-username"
                                value={username}
                                onChange={(event) => {
                                    setUsername(event.target.value);
                                    setValidationError(null);
                                }}
                                className="h-12 text-base"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="Your public username"
                                aria-invalid={validationError ? true : undefined}
                            />
                        </div>
                        <Button
                            type="submit"
                            size="lg"
                            className="h-12 w-full font-semibold"
                            disabled={
                                state.personal.status === 'FETCHING' ||
                                state.personal.status === 'ANALYZING'
                            }
                        >
                            {state.personal.status === 'FETCHING' ||
                            state.personal.status === 'ANALYZING' ? (
                                <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : (
                                <Search aria-hidden="true" />
                            )}
                            Find a position from my games
                        </Button>
                        {validationError ? (
                            <p className="text-sm text-destructive" role="alert">
                                {validationError}
                            </p>
                        ) : null}
                        <p className="text-xs leading-5 text-muted-foreground">
                            Public games only. Your username is used for this search and
                            is not included in onboarding analytics.
                        </p>
                    </form>

                    <div className="mt-6 text-sm text-muted-foreground">
                        {isSignedIn ? (
                            <Link href="/home" className="font-medium text-foreground underline underline-offset-4">
                                Open the full Backranq app
                            </Link>
                        ) : (
                            <p>
                                No account needed to try it. Sign in only when you want
                                to save and keep practicing.
                            </p>
                        )}
                    </div>
                </div>

                <div className="min-w-0 rounded-2xl border bg-background/90 p-4 shadow-xl shadow-black/5 backdrop-blur sm:p-6">
                    <PublicPuzzlePlayer
                        key={state.activePuzzle.id}
                        puzzle={state.activePuzzle}
                        compactLayout
                        statusSlot={statusSlot}
                        onAttemptStarted={() => {
                            const active = state.activePuzzle;
                            if (startedPuzzleIdsRef.current.has(active.id)) return;
                            startedPuzzleIdsRef.current.add(active.id);
                            if (active.context.kind !== 'PERSONAL') {
                                introAttemptStartedRef.current = true;
                                if (active.context.kind === 'MASTER') {
                                    emit('MASTER_ATTEMPT_STARTED', {
                                        puzzleKind: 'MASTER',
                                        masterState: 'SOLVING',
                                    });
                                }
                            } else if (state.personal.status === 'READY') {
                                emit('PERSONAL_ATTEMPT_STARTED', {
                                    runId: state.personal.runId,
                                    provider: state.personal.identity.provider,
                                    puzzleKind: 'PERSONAL',
                                });
                            }
                        }}
                        onTerminal={() => {
                            if (state.activePuzzle.context.kind === 'PERSONAL') {
                                dispatch({ type: 'MASTER_TERMINAL' });
                                if (state.personal.status === 'READY') {
                                    emit('PERSONAL_ATTEMPT_TERMINAL', {
                                        runId: state.personal.runId,
                                        provider: state.personal.identity.provider,
                                    });
                                }
                                return;
                            }
                            terminalStateRef.current = true;
                            dispatch({ type: 'MASTER_TERMINAL' });
                            if (state.activePuzzle.context.kind === 'MASTER') {
                                emit('MASTER_ATTEMPT_TERMINAL', {
                                    masterState: 'TERMINAL',
                                });
                            }
                        }}
                    />
                </div>
            </div>
        </section>
    );
}

function WorkingStatus({ title }: { title: string }) {
    return (
        <Card>
            <CardContent className="flex items-center gap-3 p-4 text-sm font-medium" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {title}
            </CardContent>
        </Card>
    );
}

function NoticeStatus({ text }: { text: string }) {
    return (
        <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="flex gap-3 p-4 text-sm" aria-live="polite">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                <p>{text}</p>
            </CardContent>
        </Card>
    );
}
