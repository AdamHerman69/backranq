import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';

type GamesSelectionDeleteDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedCount: number;
    onConfirm: () => void | Promise<void>;
    busy: boolean;
};

export function GamesSelectionDeleteDialog({
    open,
    onOpenChange,
    selectedCount,
    onConfirm,
    busy,
}: GamesSelectionDeleteDialogProps) {
    return (
        <ActionConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title={`Permanently delete ${selectedCount} selected ${selectedCount === 1 ? 'game' : 'games'}?`}
            description="This cannot be undone."
            confirmLabel={`Delete ${selectedCount} ${selectedCount === 1 ? 'game' : 'games'}`}
            onConfirm={onConfirm}
            variant="destructive"
            busy={busy}
        >
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                Deleting these {selectedCount}{' '}
                {selectedCount === 1 ? 'game' : 'games'} also permanently removes
                every associated training moment, including archived moments, and
                their attempt history.
            </div>
        </ActionConfirmDialog>
    );
}
