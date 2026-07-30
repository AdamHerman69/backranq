'use client';

import {
    AlertTriangle,
    Loader2,
    ShieldCheck,
    Sparkles,
} from 'lucide-react';

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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    COACH_CONFIRMATION_NODES,
    COACH_THRESHOLD_MAX_CP,
    COACH_THRESHOLD_MIN_CP,
    OPPONENT_PROFILES,
    getOpponentProfile,
    type OpponentProfileId,
} from '@/lib/coach';
import type {
    CoachColorChoice,
    CoachEngineWarmupStatus,
    CoachSessionSnapshot,
} from '@/lib/coach/types';

const COACH_STEPS = [
    [
        '1',
        'Play naturally',
        'Stockfish checks each decision locally after you make it.',
    ],
    [
        '2',
        'Pause at the turning point',
        'The bot does not reply until you retry, analyze, or accept the move.',
    ],
    [
        '3',
        'Explore the why',
        'Use the same move tree, live lines and threat view as Practice.',
    ],
] as const;

type CoachSetupProps = {
    colorChoice: CoachColorChoice;
    engineError: string | null;
    engineWarmup: CoachEngineWarmupStatus;
    normalizedThresholdCp: number;
    offlineAssetsReady: boolean;
    opponentId: OpponentProfileId;
    resumableSession: CoachSessionSnapshot | null;
    sessionLoaded: boolean;
    thresholdCp: number;
    onColorChoiceChange: (value: CoachColorChoice) => void;
    onDiscardSession: () => void;
    onOpponentChange: (value: OpponentProfileId) => void;
    onResume: (snapshot: CoachSessionSnapshot) => void;
    onRetryEngine: () => void;
    onStart: () => void;
    onThresholdChange: (value: number) => void;
};

export function CoachSetup({
    colorChoice,
    engineError,
    engineWarmup,
    normalizedThresholdCp,
    offlineAssetsReady,
    opponentId,
    resumableSession,
    sessionLoaded,
    thresholdCp,
    onColorChoiceChange,
    onDiscardSession,
    onOpponentChange,
    onResume,
    onRetryEngine,
    onStart,
    onThresholdChange,
}: CoachSetupProps) {
    const selectedOpponent = getOpponentProfile(opponentId);
    const engineLoading =
        engineWarmup === 'loading' || engineWarmup === 'idle';

    return (
        <section
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]"
            aria-label="Coach game setup"
        >
            {sessionLoaded && resumableSession ? (
                <Card className="border-primary/30 lg:col-span-2">
                    <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <div className="font-medium">
                                Continue your saved game
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {resumableSession.moves.length} moves ·{' '}
                                {getOpponentProfile(
                                    resumableSession.opponentId
                                ).label}{' '}
                                opponent · {resumableSession.thresholdCp} cp
                                threshold · saved on this device
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                onClick={() => onResume(resumableSession)}
                            >
                                Continue game
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={onDiscardSession}
                            >
                                Discard local game
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <CardTitle>Set up your game</CardTitle>
                            <CardDescription className="mt-2">
                                Choose how the opponent plays and when the
                                coach should interrupt.
                            </CardDescription>
                        </div>
                        <Badge
                            variant={
                                engineWarmup === 'ready'
                                    ? 'secondary'
                                    : 'outline'
                            }
                            className="shrink-0 whitespace-nowrap"
                        >
                            {engineLoading ? (
                                <Loader2
                                    className="mr-1 h-3.5 w-3.5 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : engineWarmup === 'ready' ? (
                                <ShieldCheck
                                    className="mr-1 h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                            ) : (
                                <AlertTriangle
                                    className="mr-1 h-3.5 w-3.5"
                                    aria-hidden="true"
                                />
                            )}
                            {engineWarmup === 'ready'
                                ? offlineAssetsReady
                                    ? 'Offline assets saved'
                                    : 'Engine ready'
                                : engineWarmup === 'error'
                                  ? 'Engine unavailable'
                                  : 'Loading engine'}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-4 sm:grid-cols-3">
                        <label className="space-y-2 text-sm">
                            <span className="font-medium">Your color</span>
                            <Select
                                value={colorChoice}
                                onValueChange={(value) =>
                                    onColorChoiceChange(
                                        value as CoachColorChoice
                                    )
                                }
                            >
                                <SelectTrigger aria-label="Your color">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="white">
                                        White
                                    </SelectItem>
                                    <SelectItem value="black">
                                        Black
                                    </SelectItem>
                                    <SelectItem value="random">
                                        Random
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </label>

                        <label className="space-y-2 text-sm">
                            <span className="font-medium">Opponent</span>
                            <Select
                                value={opponentId}
                                onValueChange={(value) =>
                                    onOpponentChange(
                                        value as OpponentProfileId
                                    )
                                }
                            >
                                <SelectTrigger aria-label="Opponent strength">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {OPPONENT_PROFILES.map((profile) => (
                                        <SelectItem
                                            key={profile.id}
                                            value={profile.id}
                                        >
                                            {profile.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </label>

                        <label className="space-y-2 text-sm">
                            <span className="font-medium">
                                Stop threshold
                            </span>
                            <div className="relative">
                                <Input
                                    type="number"
                                    min={COACH_THRESHOLD_MIN_CP}
                                    max={COACH_THRESHOLD_MAX_CP}
                                    step={10}
                                    inputMode="numeric"
                                    value={thresholdCp}
                                    onChange={(event) =>
                                        onThresholdChange(
                                            Number(
                                                event.currentTarget.value
                                            ) || 0
                                        )
                                    }
                                    onBlur={() =>
                                        onThresholdChange(
                                            normalizedThresholdCp
                                        )
                                    }
                                    aria-label="Centipawn loss threshold"
                                    className="pr-10 font-mono"
                                />
                                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                                    cp
                                </span>
                            </div>
                        </label>
                    </div>

                    <div className="grid gap-3 rounded-lg border bg-muted/25 p-4 sm:grid-cols-2">
                        <div>
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {selectedOpponent.label} opponent
                            </div>
                            <p className="mt-1 text-sm">
                                {selectedOpponent.description}
                            </p>
                        </div>
                        <div>
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Stop at ≥ {normalizedThresholdCp} cp loss
                            </div>
                            <p className="mt-1 text-sm">
                                Near-threshold decisions are confirmed at{' '}
                                {Math.round(
                                    COACH_CONFIRMATION_NODES / 1_000
                                )}
                                k nodes before the game pauses.
                            </p>
                        </div>
                    </div>

                    <Button
                        type="button"
                        size="lg"
                        className="w-full sm:w-auto"
                        disabled={engineWarmup !== 'ready'}
                        onClick={onStart}
                    >
                        {engineLoading ? (
                            <Loader2
                                className="mr-2 h-4 w-4 animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <Sparkles
                                className="mr-2 h-4 w-4"
                                aria-hidden="true"
                            />
                        )}
                        {engineLoading
                            ? 'Preparing Stockfish…'
                            : 'Start coach game'}
                    </Button>

                    {engineWarmup === 'error' ? (
                        <div
                            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                            role="alert"
                        >
                            <p className="text-sm text-destructive">
                                {engineError}
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={onRetryEngine}
                            >
                                Retry local engine
                            </Button>
                        </div>
                    ) : null}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">
                        How coaching works
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <ol className="space-y-4 text-sm">
                        {COACH_STEPS.map(([number, title, detail]) => (
                            <li
                                key={number}
                                className="flex items-start gap-3"
                            >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                                    {number}
                                </span>
                                <span>
                                    <span className="font-medium">
                                        {title}
                                    </span>
                                    <span className="mt-0.5 block text-muted-foreground">
                                        {detail}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ol>
                    <div className="mt-5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
                        {offlineAssetsReady
                            ? 'The static coach shell, Stockfish runtime, analysis workspace and app assets are saved for a cold offline start.'
                            : engineWarmup === 'ready'
                              ? 'Stockfish is loaded, so this open session can continue offline. The production app also saves a cold-start offline shell.'
                              : 'Stockfish and the analysis workspace are prepared locally before a game can start.'}
                    </div>
                </CardContent>
            </Card>
        </section>
    );
}
