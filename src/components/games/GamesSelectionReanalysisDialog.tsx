import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import Link from 'next/link';

type GamesSelectionSummary = {
    analyzed: number;
    trainingMoments: number;
};

type GamesSelectionReanalysisDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedCount: number;
    maximumQueueable: number;
    selectedSummary: GamesSelectionSummary;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
    onConfirm: () => void | Promise<void>;
    busy: boolean;
};

export function GamesSelectionReanalysisDialog({
    open,
    onOpenChange,
    selectedCount,
    maximumQueueable,
    selectedSummary,
    serverAnalysisCapacity,
    onConfirm,
    busy,
}: GamesSelectionReanalysisDialogProps) {
    return (
        <ActionConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title={`Re-analyze ${selectedCount} selected ${selectedCount === 1 ? 'game' : 'games'}?`}
            description={`Server re-analysis runs in the background and uses ${serverAnalysisCapacity.creditsPerGame} credits per accepted game.`}
            confirmLabel={`Queue up to ${maximumQueueable} ${maximumQueueable === 1 ? 'game' : 'games'}`}
            onConfirm={onConfirm}
            busy={busy}
            confirmDisabled={maximumQueueable < 1}
        >
            <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-muted-foreground">Selected games</dt>
                    <dd className="font-semibold">{selectedCount}</dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Requested maximum cost
                    </dt>
                    <dd className="font-semibold">
                        {selectedCount * serverAnalysisCapacity.creditsPerGame}{' '}
                        credits ({serverAnalysisCapacity.creditsPerGame} per game)
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">Quality</dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.analysisQuality === 'THOROUGH'
                            ? 'Thorough'
                            : 'Standard'}{' '}
                        ·{' '}
                        <Link
                            href="/settings#analysis-defaults"
                            className="font-normal underline"
                        >
                            Change quality
                        </Link>
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Current credit balance
                    </dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.currentBalance}{' '}
                        {serverAnalysisCapacity.currentBalance === 1
                            ? 'credit'
                            : 'credits'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Manual reservable capacity
                    </dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.reservableGames}{' '}
                        {serverAnalysisCapacity.reservableGames === 1
                            ? 'game'
                            : 'games'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Maximum newly queueable
                    </dt>
                    <dd className="font-semibold">
                        {maximumQueueable} of {selectedCount}{' '}
                        {selectedCount === 1 ? 'game' : 'games'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Outstanding reservations
                    </dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.outstandingReservations}{' '}
                        {serverAnalysisCapacity.outstandingReservations === 1
                            ? 'credit'
                            : 'credits'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">
                        Monthly capacity after reservations
                    </dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.monthlyRemaining}{' '}
                        {serverAnalysisCapacity.monthlyRemaining === 1
                            ? 'credit'
                            : 'credits'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">Safety floor</dt>
                    <dd className="font-semibold">
                        {serverAnalysisCapacity.stopThreshold}{' '}
                        {serverAnalysisCapacity.stopThreshold === 1
                            ? 'credit'
                            : 'credits'}
                    </dd>
                </div>
                <div>
                    <dt className="text-muted-foreground">Existing analysis</dt>
                    <dd className="font-semibold">
                        {selectedSummary.analyzed} of {selectedCount}{' '}
                        {selectedCount === 1 ? 'game' : 'games'}
                    </dd>
                </div>
                <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">Impact</dt>
                    <dd>
                        Each completed re-analysis replaces that game&apos;s current
                        evaluation. Matching positions receive new revisions, stale
                        positions are archived, and new positions are added. The
                        selection currently contains{' '}
                        {selectedSummary.trainingMoments} visible practice{' '}
                        {selectedSummary.trainingMoments === 1
                            ? 'position'
                            : 'positions'}. Attempt history is preserved. Already queued games may be
                        skipped and do not add another charge.
                    </dd>
                </div>
                <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">Capacity note</dt>
                    <dd>{serverAnalysisCapacity.limitingReason}</dd>
                </div>
                {selectedCount > serverAnalysisCapacity.reservableGames ? (
                    <div className="sm:col-span-2">
                        <dt className="font-medium text-amber-700 dark:text-amber-300">
                            Partial queue expected
                        </dt>
                        <dd>
                            Current manual capacity can reserve at most{' '}
                            {maximumQueueable}{' '}
                            {maximumQueueable === 1 ? 'game' : 'games'}. Remaining
                            games will not be queued unless earlier selections are
                            already queued or running and therefore skipped without
                            a new reservation.
                        </dd>
                    </div>
                ) : null}
            </dl>
        </ActionConfirmDialog>
    );
}
