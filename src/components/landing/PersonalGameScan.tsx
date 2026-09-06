'use client';

import { useState } from 'react';
import { Loader2, Pause, Play, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PersonalSearchState } from '@/lib/onboarding/state';

export type ScanState = Exclude<PersonalSearchState, { status: 'IDLE' | 'READY' }>;
type AnalyzingState = Extract<ScanState, { status: 'ANALYZING' }>;

export function useScanPlayback(personal: ScanState | undefined) {
    const [pausedAt, setPausedAt] = useState<AnalyzingState | null>(null);
    const [resumedAt, setResumedAt] = useState<AnalyzingState | null>(null);
    const analyzing = personal?.status === 'ANALYZING' ? personal : null;
    const paused = analyzing && pausedAt?.runId === analyzing.runId ? pausedAt : null;
    const displayed = analyzing ? paused ?? analyzing : null;
    return {
        displayed,
        paused: Boolean(paused),
        animationMs: paused || resumedAt === displayed ? 0 : displayed?.animationMs ?? 0,
        toggle: () => {
            setResumedAt(paused ? analyzing : null);
            setPausedAt(paused ? null : analyzing);
        },
    };
}

export function PersonalGameScanHeader({ personal, playback }: {
    personal: ScanState;
    playback: ReturnType<typeof useScanPlayback>;
}) {
    const preview = playback.displayed?.progress.preview;
    const title = personal.status === 'FETCHING'
        ? 'Finding your recent games'
        : personal.status === 'ERROR'
          ? 'Your search could not finish'
          : personal.status === 'EMPTY'
            ? 'No personal position found'
            : 'Finding your next position';
    const playedDate = preview ? new Date(preview.playedAt) : null;
    return <>
        <div className="min-w-0 flex-1">
            <p className="editorial-label">Your games</p>
            <h2 className="mt-1.5 text-balance text-lg font-semibold tracking-[-0.025em] sm:text-xl">{title}</h2>
            {preview ? <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                {preview.whiteName} vs {preview.blackName}
                {playedDate && Number.isFinite(playedDate.getTime()) ?
                    <> · {playedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</> : null}
            </p> : null}
        </div>
        {personal.status === 'ANALYZING' && personal.progress.preview ? <Button
            type="button" variant="outline" size="icon" className="shrink-0"
            aria-label={playback.paused ? 'Resume game playback' : 'Pause game playback'}
            onClick={playback.toggle}
        >{playback.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</Button> : null}
    </>;
}

export function PersonalGameScanPlaceholder({ personal }: { personal: ScanState }) {
    const working = personal.status === 'FETCHING' || personal.status === 'ANALYZING';
    return <div className="absolute inset-0 flex items-center justify-center rounded-[0.7rem] border border-foreground/15 bg-secondary p-8 text-center">
        <div className="max-w-xs space-y-3">
            {working ? <Loader2 className="mx-auto h-7 w-7 animate-spin motion-reduce:animate-none" aria-hidden="true" /> :
                <Search className="mx-auto h-7 w-7" aria-hidden="true" />}
            <p className="text-sm text-muted-foreground">{working
                ? 'Your game will appear here as soon as analysis starts.'
                : 'Try another public profile or search again using the form.'}</p>
        </div>
    </div>;
}

export function PersonalGameScanStatus({ personal, playback }: {
    personal: ScanState;
    playback: ReturnType<typeof useScanPlayback>;
}) {
    if (personal.status !== 'FETCHING' && personal.status !== 'ANALYZING') return null;
    const progress = playback.displayed?.progress;
    const phaseLabel = playback.paused
        ? 'Playback paused · analysis continues'
        : progress?.phase === 'CONFIRMING'
          ? 'Verifying a possible training position'
          : progress?.phase === 'SCANNING'
            ? `Reviewing game ${progress.gameIndex + 1} of ${progress.gameCount}`
            : 'Preparing your game analysis';
    return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p role="status">{phaseLabel}</p>
        {progress?.preview ? <p>Move {progress.preview.fen.split(' ')[5]}</p> : null}
    </div>;
}
