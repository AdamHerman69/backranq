'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ModalDialog } from '@/components/ui/ModalDialog';
import { publishLibraryChanged } from '@/lib/analysis/analysisCompletion';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';

type ImportResponse = {
    created: number;
    duplicates: number;
    createdGameIds: string[];
    duplicateGameIds: string[];
    needsAnalysisGameIds: string[];
    error?: string;
};

export function ManualPgnImportButton({ ownerId }: { ownerId: string }) {
    const router = useRouter();
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [open, setOpen] = useState(false);
    const [pgn, setPgn] = useState('');
    const [playerName, setPlayerName] = useState('');
    const [analyze, setAnalyze] = useState(true);
    const [busy, setBusy] = useState(false);

    async function chooseFile(file: File | undefined) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.pgn')) {
            toast.error('Choose a .pgn file.');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            toast.error('PGN files can be up to 2 MB.');
            return;
        }
        setPgn(await file.text());
    }

    async function submit() {
        if (!pgn.trim() || !playerName.trim()) return;
        setBusy(true);
        try {
            const response = await fetch('/api/games/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pgn, playerName }),
            });
            const result = (await response.json().catch(() => ({}))) as
                ImportResponse;
            if (!response.ok) {
                throw new Error(result.error ?? 'The PGN could not be imported.');
            }

            publishLibraryChanged(ownerId, { invalidateCompletion: true });
            if (analyze && result.needsAnalysisGameIds.length > 0) {
                backgroundAnalysis.setOwner(ownerId);
                backgroundAnalysis.enqueueGameDbIds(
                    ownerId,
                    result.needsAnalysisGameIds
                );
            }
            const duplicateText = result.duplicates
                ? ` ${result.duplicates} already in your library.`
                : '';
            const analysisText =
                analyze && result.needsAnalysisGameIds.length > 0
                    ? ' Free browser analysis started; keep Backranq open. Practice updates automatically as verified positions are found.'
                    : '';
            toast.success(
                `${result.created} ${result.created === 1 ? 'game' : 'games'} imported.${duplicateText}${analysisText}`
            );
            setOpen(false);
            setPgn('');
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : 'The PGN could not be imported.'
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setOpen(true)}
            >
                <FileUp aria-hidden="true" />
                Import PGN
            </Button>
            <ModalDialog
                open={open}
                onOpenChange={(next) => !busy && setOpen(next)}
                title="Import PGN games"
                description="Paste one or more games, or choose a PGN file. Backranq uses your side of each game to find positions worth practising."
                className="max-w-2xl"
            >
                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <label
                            htmlFor="pgn-player-name"
                            className="text-sm font-medium"
                        >
                            Your name in these games
                        </label>
                        <Input
                            id="pgn-player-name"
                            value={playerName}
                            onChange={(event) => setPlayerName(event.target.value)}
                            placeholder="Player name from the PGN"
                            disabled={busy}
                            autoComplete="off"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                            <label
                                htmlFor="pgn-source"
                                className="text-sm font-medium"
                            >
                                PGN
                            </label>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                Choose file
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pgn,application/x-chess-pgn,text/plain"
                                className="sr-only"
                                onChange={(event) => {
                                    void chooseFile(event.target.files?.[0]);
                                    event.currentTarget.value = '';
                                }}
                            />
                        </div>
                        <textarea
                            id="pgn-source"
                            value={pgn}
                            onChange={(event) => setPgn(event.target.value)}
                            placeholder={'[Event "My game"]\n[White "..."]\n[Black "..."]\n\n1. e4 ...'}
                            disabled={busy}
                            rows={12}
                            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <p className="text-xs text-muted-foreground">
                            Up to 50 games or 2 MB per import.
                        </p>
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={analyze}
                            onChange={(event) => setAnalyze(event.target.checked)}
                            disabled={busy}
                            className="mt-0.5"
                        />
                        <span>
                            Analyze in this browser after import (0 credits) and
                            add verified positions to Practice. Backranq must stay
                            open until analysis finishes.
                        </span>
                    </label>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            disabled={busy || !pgn.trim() || !playerName.trim()}
                            onClick={() => void submit()}
                        >
                            {busy ? (
                                <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : null}
                            Import games
                        </Button>
                    </div>
                </div>
            </ModalDialog>
        </>
    );
}
