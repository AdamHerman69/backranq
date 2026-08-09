'use client';

import { useState } from 'react';
import {
    AlertTriangle,
    HardDrive,
    Loader2,
    ShieldCheck,
    Sparkles,
} from 'lucide-react';

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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    COACH_CONFIRMATION_NODES,
    MAIA_OPPONENT_ELO_STEP,
    MAIA_OPPONENT_MAX_ELO,
    MAIA_OPPONENT_MIN_ELO,
    MAIA_TACTICAL_GUARD_CP_STEP,
    MAIA_TACTICAL_GUARD_MAX_CP,
    MAIA_TACTICAL_GUARD_MIN_CP,
    MAIA_TACTICAL_GUARD_NODES,
    COACH_THRESHOLD_MAX_CP,
    COACH_THRESHOLD_MIN_CP,
    OPPONENT_PROFILES,
    getOpponentProfile,
    isMaiaOpponentModel,
    isMaiaTacticalGuardModel,
    normalizeMaiaOpponentElo,
    type CoachOpponentModelId,
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
    maiaElo: number;
    maiaError: string | null;
    maiaModelBytes: number;
    maiaDownloadMiB: number;
    maiaModelLabel: string;
    maiaModelLicenseStatus: string;
    maiaModelProjectUrl: string;
    maiaModelProvenance: string;
    maiaModelSourceUrl: string;
    maiaHasStoredData: boolean;
    maiaInstalled: boolean;
    maiaInstallChecking: boolean;
    maiaOfflineReady: boolean;
    maiaPhase:
        | 'idle'
        | 'checking-cache'
        | 'downloading'
        | 'verifying'
        | 'loading'
        | 'ready'
        | 'error'
        | 'terminated';
    maiaProgress: number | null;
    normalizedTacticalGuardCp: number;
    normalizedThresholdCp: number;
    offlineAssetsReady: boolean;
    opponentId: OpponentProfileId;
    opponentModel: CoachOpponentModelId;
    resumableSession: CoachSessionSnapshot | null;
    sessionLoaded: boolean;
    thresholdCp: number;
    tacticalGuardCp: number;
    onColorChoiceChange: (value: CoachColorChoice) => void;
    onDiscardSession: () => void;
    onMaiaEloChange: (value: number) => void;
    onOpponentChange: (value: OpponentProfileId) => void;
    onOpponentModelChange: (value: CoachOpponentModelId) => void;
    onResume: (snapshot: CoachSessionSnapshot) => void;
    onRetryEngine: () => void;
    onRetryMaia: () => void;
    onRemoveMaia: () => Promise<string | null>;
    onStart: () => void;
    onThresholdChange: (value: number) => void;
    onTacticalGuardChange: (value: number) => void;
};

export function CoachSetup({
    colorChoice,
    engineError,
    engineWarmup,
    maiaElo,
    maiaError,
    maiaModelBytes,
    maiaDownloadMiB,
    maiaModelLabel,
    maiaModelLicenseStatus,
    maiaModelProjectUrl,
    maiaModelProvenance,
    maiaModelSourceUrl,
    maiaHasStoredData,
    maiaInstalled,
    maiaInstallChecking,
    maiaOfflineReady,
    maiaPhase,
    maiaProgress,
    normalizedTacticalGuardCp,
    normalizedThresholdCp,
    offlineAssetsReady,
    opponentId,
    opponentModel,
    resumableSession,
    sessionLoaded,
    thresholdCp,
    tacticalGuardCp,
    onColorChoiceChange,
    onDiscardSession,
    onMaiaEloChange,
    onOpponentChange,
    onOpponentModelChange,
    onResume,
    onRetryEngine,
    onRetryMaia,
    onRemoveMaia,
    onStart,
    onThresholdChange,
    onTacticalGuardChange,
}: CoachSetupProps) {
    const [removeMaiaDialogOpen, setRemoveMaiaDialogOpen] =
        useState(false);
    const [removingMaia, setRemovingMaia] = useState(false);
    const [removeMaiaError, setRemoveMaiaError] =
        useState<string | null>(null);
    const selectedOpponent = getOpponentProfile(opponentId);
    const maiaSelected = isMaiaOpponentModel(opponentModel);
    const tacticalGuardSelected =
        isMaiaTacticalGuardModel(opponentModel);
    const engineLoading =
        engineWarmup === 'loading' || engineWarmup === 'idle';
    const maiaLoading =
        maiaSelected &&
        maiaPhase !== 'ready' &&
        maiaPhase !== 'error';
    const selectedOpponentReady =
        opponentModel === 'stockfish' || maiaPhase === 'ready';
    const startReady =
        engineWarmup === 'ready' && selectedOpponentReady;
    const resumableOpponentReady =
        !resumableSession ||
        resumableSession.phase === 'gameover' ||
        !isMaiaOpponentModel(resumableSession.opponentModel) ||
        maiaPhase === 'ready';
    const modelSizeMiB = (
        maiaModelBytes /
        (1024 * 1024)
    ).toFixed(1);
    const announcedMaiaProgress =
        maiaProgress == null
            ? null
            : Math.floor((maiaProgress * 100) / 10) * 10;
    const maiaStatusAnnouncement =
        maiaPhase === 'ready'
            ? maiaOfflineReady
                ? 'Maia opponent is ready offline.'
                : 'Maia opponent is ready for this session but was not saved offline.'
            : maiaPhase === 'error'
              ? `Maia opponent failed to load. ${maiaError ?? ''}`
              : maiaPhase === 'idle'
                ? 'Preparing Maia opponent automatically.'
              : maiaPhase === 'downloading' &&
                  announcedMaiaProgress != null
                ? `Downloading Maia opponent: ${announcedMaiaProgress} percent.`
                : 'Preparing Maia opponent.';

    return (
        <section
            className="mx-auto max-w-6xl space-y-4"
            aria-label="Coach game setup"
        >
            {sessionLoaded && resumableSession ? (
                <Card className="border-primary/30 bg-primary/[0.025]">
                    <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <div className="font-medium">
                                {resumableSession.phase === 'gameover'
                                    ? 'Completed game waiting to be saved'
                                    : 'Continue your saved game'}
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {resumableSession.moves.length} moves ·{' '}
                                {isMaiaOpponentModel(
                                    resumableSession.opponentModel
                                )
                                    ? `${isMaiaTacticalGuardModel(resumableSession.opponentModel) ? 'Maia + tactical guard' : 'Maia 3'} · ${resumableSession.opponentElo} Elo${resumableSession.tacticalGuardCp == null ? '' : ` · guard at ${resumableSession.tacticalGuardCp} cp`}`
                                    : `Stockfish · ${getOpponentProfile(
                                          resumableSession.opponentId
                                      ).label}`}{' '}
                                · {resumableSession.thresholdCp} cp threshold ·
                                saved on this device
                            </p>
                            {!resumableOpponentReady &&
                            !maiaInstallChecking ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    The saved game is intact. Maia is being
                                    prepared automatically before you continue.
                                </p>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                disabled={!resumableOpponentReady}
                                onClick={() => onResume(resumableSession)}
                            >
                                {resumableOpponentReady
                                    ? resumableSession.phase === 'gameover'
                                        ? 'Review completed game'
                                        : 'Continue game'
                                    : maiaInstallChecking
                                      ? 'Checking saved Maia…'
                                      : 'Preparing Maia to continue…'}
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

            <Card className="overflow-hidden border-x-0 sm:border-x">
                <CardHeader className="border-b bg-muted/20 p-3 sm:p-6 sm:pb-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <CardTitle>Set up your game</CardTitle>
                            <CardDescription className="mt-2 hidden sm:block">
                                Pick a side, opponent and level. You can start
                                as soon as the local coach is ready.
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
                <CardContent className="space-y-4 p-3 sm:space-y-5 sm:p-6">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
                        <label className="min-w-0 space-y-1.5 text-sm sm:space-y-2">
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

                        <label className="min-w-0 space-y-1.5 text-sm sm:space-y-2">
                            <span className="font-medium">
                                Opponent
                            </span>
                            <Select
                                value={opponentModel}
                                onValueChange={(value) =>
                                    onOpponentModelChange(
                                        value as CoachOpponentModelId
                                    )
                                }
                            >
                                <SelectTrigger aria-label="Opponent model">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="stockfish">
                                        Stockfish · engine-like
                                    </SelectItem>
                                    <SelectItem value="maia3">
                                        Maia 3 · human-like
                                    </SelectItem>
                                    <SelectItem value="maia3-tactical">
                                        Maia + tactical guard
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </label>

                        <label className="min-w-0 space-y-1.5 text-sm sm:space-y-2">
                            {opponentModel === 'stockfish' ? (
                                <>
                                    <span className="font-medium">
                                        Playing level
                                    </span>
                                    <Select
                                        value={opponentId}
                                        onValueChange={(value) =>
                                            onOpponentChange(
                                                value as OpponentProfileId
                                            )
                                        }
                                    >
                                        <SelectTrigger aria-label="Stockfish strength">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {OPPONENT_PROFILES.map(
                                                (profile) => (
                                                    <SelectItem
                                                        key={profile.id}
                                                        value={profile.id}
                                                    >
                                                        {profile.label}
                                                    </SelectItem>
                                                )
                                            )}
                                        </SelectContent>
                                    </Select>
                                </>
                            ) : (
                                <>
                                    <span className="font-medium">
                                        Playing level
                                    </span>
                                    <div className="relative">
                                        <Input
                                            type="number"
                                            min={MAIA_OPPONENT_MIN_ELO}
                                            max={MAIA_OPPONENT_MAX_ELO}
                                            step={MAIA_OPPONENT_ELO_STEP}
                                            inputMode="numeric"
                                            value={maiaElo}
                                            onChange={(event) =>
                                                onMaiaEloChange(
                                                    Number(
                                                        event.currentTarget
                                                            .value
                                                    ) || 0
                                                )
                                            }
                                            onBlur={() =>
                                                onMaiaEloChange(
                                                    normalizeMaiaOpponentElo(
                                                        maiaElo
                                                    )
                                                )
                                            }
                                            aria-label="Maia opponent Elo"
                                            className="pr-12 font-mono"
                                        />
                                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                                            Elo
                                        </span>
                                    </div>
                                </>
                            )}
                        </label>

                        <label className="min-w-0 space-y-1.5 text-sm sm:space-y-2">
                            <span className="font-medium">
                                Coach sensitivity
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

                        {tacticalGuardSelected ? (
                            <label className="col-span-2 space-y-2 text-sm lg:col-span-4">
                                <span className="font-medium">
                                    Tactical safety guard
                                </span>
                                <div className="relative max-w-xs">
                                    <Input
                                        type="number"
                                        min={MAIA_TACTICAL_GUARD_MIN_CP}
                                        max={MAIA_TACTICAL_GUARD_MAX_CP}
                                        step={MAIA_TACTICAL_GUARD_CP_STEP}
                                        inputMode="numeric"
                                        value={tacticalGuardCp}
                                        onChange={(event) =>
                                            onTacticalGuardChange(
                                                Number(
                                                    event.currentTarget
                                                        .value
                                                ) || 0
                                            )
                                        }
                                        onBlur={() =>
                                            onTacticalGuardChange(
                                                normalizedTacticalGuardCp
                                            )
                                        }
                                        aria-label="Tactical guard centipawn threshold"
                                        className="pr-10 font-mono"
                                    />
                                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                                        cp
                                    </span>
                                </div>
                            </label>
                        ) : null}
                    </div>

                    <div
                        className="flex flex-col gap-3 border-y border-foreground/15 bg-foreground p-3 text-background sm:flex-row sm:items-center sm:justify-between sm:p-4"
                        data-coach-setup-primary
                    >
                        <div className="min-w-0 text-sm">
                            <div className="font-medium">
                                {maiaSelected
                                    ? `${tacticalGuardSelected ? 'Maia + tactical guard' : 'Maia 3'} · ${maiaElo} Elo`
                                    : `${selectedOpponent.label} Stockfish`}
                            </div>
                            <p className="mt-0.5 text-xs text-background/65">
                                Coach pauses at ≥ {normalizedThresholdCp} cp loss
                                {tacticalGuardSelected
                                    ? ` · guard at ${normalizedTacticalGuardCp} cp`
                                    : ''}
                            </p>
                        </div>
                        <Button
                            type="button"
                            size="lg"
                            className="min-h-11 w-full shrink-0 border-accent bg-accent text-accent-foreground hover:bg-accent/90 sm:min-h-12 sm:w-auto sm:min-w-52"
                            disabled={!startReady}
                            onClick={onStart}
                        >
                            {engineLoading || maiaLoading ? (
                                <Loader2
                                    className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                />
                            ) : (
                                <Sparkles
                                    className="mr-2 h-4 w-4"
                                    aria-hidden="true"
                                />
                            )}
                            {engineLoading
                                ? 'Preparing local coach…'
                                : maiaLoading
                                  ? 'Preparing Maia opponent…'
                                  : maiaSelected && maiaPhase !== 'ready'
                                    ? 'Maia needs attention'
                                    : 'Start coach game'}
                        </Button>
                    </div>

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
                                Retry local coach
                            </Button>
                        </div>
                    ) : null}

                    {maiaSelected ? (
                        <div
                            className="rounded-xl border p-3"
                            data-maia-phase={maiaPhase}
                        >
                            <div className="flex items-start gap-3">
                                {maiaPhase === 'ready' ? (
                                    <HardDrive
                                        className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                                        aria-hidden="true"
                                    />
                                ) : maiaPhase === 'error' ? (
                                    <AlertTriangle
                                        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <Loader2
                                        className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                )}
                                <div className="min-w-0 flex-1">
                                    <span
                                        className="sr-only"
                                        role="status"
                                        aria-live="polite"
                                        aria-atomic="true"
                                    >
                                        {maiaStatusAnnouncement}
                                    </span>
                                    <div className="text-sm font-medium">
                                        {maiaPhase === 'ready'
                                            ? maiaOfflineReady
                                                ? 'Human-like opponent saved offline'
                                                : 'Human-like opponent ready for this session'
                                            : maiaPhase === 'error'
                                              ? 'Maia model unavailable'
                                              : maiaPhase === 'idle'
                                                ? 'Preparing human-like opponent…'
                                              : maiaPhase === 'downloading'
                                                ? `Preparing human-like opponent${maiaProgress == null ? '…' : ` · ${Math.round(maiaProgress * 100)}%`}`
                                                : 'Preparing human-like opponent…'}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {maiaModelLabel} · {modelSizeMiB} MiB
                                    </p>
                                    {maiaPhase === 'idle' ? (
                                        <p className="mt-3 text-xs text-muted-foreground">
                                            {maiaInstalled
                                                ? 'The verified model and runtime are saved on this device and are loading automatically.'
                                                : `First use prepares approximately ${maiaDownloadMiB.toFixed(1)} MiB from the immutable Maia source and saves it for offline play.`}
                                        </p>
                                    ) : null}
                                    {maiaProgress != null &&
                                    maiaPhase !== 'ready' &&
                                    maiaPhase !== 'error' ? (
                                        <div
                                            className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                                            role="progressbar"
                                            aria-label="Maia preparation progress"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={Math.round(
                                                maiaProgress * 100
                                            )}
                                        >
                                            <div
                                                className="h-full rounded-full bg-primary transition-[width]"
                                                style={{
                                                    width: `${Math.round(
                                                        maiaProgress * 100
                                                    )}%`,
                                                }}
                                            />
                                        </div>
                                    ) : null}
                                    {maiaPhase === 'error' ? (
                                        <div
                                            className="mt-3 flex flex-wrap items-center gap-3"
                                            role="alert"
                                        >
                                            <p className="text-xs text-destructive">
                                                {maiaError}
                                            </p>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={onRetryMaia}
                                            >
                                                Retry Maia preparation
                                            </Button>
                                        </div>
                                    ) : null}
                                    {maiaHasStoredData ||
                                    maiaPhase === 'ready' ||
                                    maiaPhase === 'error' ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            className="mt-3"
                                            onClick={() => {
                                                setRemoveMaiaError(null);
                                                setRemoveMaiaDialogOpen(
                                                    true
                                                );
                                            }}
                                        >
                                            Remove Maia data
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    ) : null}

                    <details className="group rounded-xl border bg-muted/10">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center justify-between gap-3">
                                How coaching and local engines work
                                <span
                                    className="text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                                    aria-hidden="true"
                                >
                                    ↓
                                </span>
                            </span>
                        </summary>
                        <div className="space-y-5 border-t p-4">
                            <div className="grid gap-3 rounded-lg border bg-background p-4 sm:grid-cols-2">
                                <div>
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Opponent behavior
                                    </div>
                                    <p className="mt-1 text-sm">
                                        {tacticalGuardSelected
                                            ? `Keeps Maia’s human move distribution, but rejects candidates at ≥ ${normalizedTacticalGuardCp} cp loss using a ${Math.round(MAIA_TACTICAL_GUARD_NODES / 1_000)}k-node Stockfish check.`
                                            : opponentModel === 'maia3'
                                              ? 'Predicts moves people at this rating actually play. Stockfish remains the independent coach and judge.'
                                              : selectedOpponent.description}
                                    </p>
                                </div>
                                <div>
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Coach confirmation
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

                            <ol className="grid gap-3 text-sm sm:grid-cols-3">
                                {COACH_STEPS.map(([number, title, detail]) => (
                                    <li
                                        key={number}
                                        className="rounded-lg border bg-background p-3"
                                    >
                                        <span className="text-xs font-semibold text-primary">
                                            {number.padStart(2, '0')}
                                        </span>
                                        <span className="mt-2 block font-medium">
                                            {title}
                                        </span>
                                        <span className="mt-1 block text-xs text-muted-foreground">
                                            {detail}
                                        </span>
                                    </li>
                                ))}
                            </ol>

                            {maiaSelected ? (
                                <div className="space-y-1 text-xs text-muted-foreground">
                                    <p>
                                        {maiaModelBytes.toLocaleString('en-US')}{' '}
                                        bytes · {maiaModelProvenance}
                                    </p>
                                    <p>
                                        <a
                                            className="underline underline-offset-2"
                                            href={maiaModelSourceUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            Immutable model source
                                        </a>{' '}
                                        ·{' '}
                                        <a
                                            className="underline underline-offset-2"
                                            href={maiaModelProjectUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            Maia upstream
                                        </a>{' '}
                                        · license status:{' '}
                                        {maiaModelLicenseStatus.replaceAll(
                                            '-',
                                            ' '
                                        )}
                                    </p>
                                </div>
                            ) : null}

                            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
                                {offlineAssetsReady
                                    ? maiaSelected &&
                                      (!maiaOfflineReady ||
                                          maiaPhase !== 'ready')
                                        ? maiaPhase === 'idle'
                                            ? `The coach shell and Stockfish judge are saved offline. The selected Maia opponent is preparing automatically (approximately ${maiaDownloadMiB.toFixed(1)} MiB on first use).`
                                            : 'The coach shell and Stockfish judge are saved offline. Maia will also be available offline once preparation is saved successfully.'
                                        : 'The coach shell, Stockfish judge, selected opponent and analysis workspace are saved for a cold offline start.'
                                    : engineWarmup === 'ready'
                                      ? 'The Stockfish judge is loaded, so this open session can continue offline. The production app also saves a cold-start offline shell.'
                                      : 'The Stockfish judge and analysis workspace are prepared locally before a game can start.'}
                            </div>
                        </div>
                    </details>
                </CardContent>
            </Card>
            <ActionConfirmDialog
                open={removeMaiaDialogOpen}
                onOpenChange={setRemoveMaiaDialogOpen}
                title="Remove Maia from this device?"
                description={`This removes the verified model and local runtime (about ${maiaDownloadMiB.toFixed(1)} MiB total). Selecting Maia again will prepare them automatically.`}
                confirmLabel="Remove Maia data"
                variant="destructive"
                busy={removingMaia}
                onConfirm={async () => {
                    setRemovingMaia(true);
                    const error = await onRemoveMaia();
                    setRemovingMaia(false);
                    if (error) {
                        setRemoveMaiaError(error);
                    } else {
                        setRemoveMaiaDialogOpen(false);
                    }
                }}
            >
                {removeMaiaError ? (
                    <p className="text-sm text-destructive" role="alert">
                        {removeMaiaError}
                    </p>
                ) : null}
            </ActionConfirmDialog>
        </section>
    );
}
