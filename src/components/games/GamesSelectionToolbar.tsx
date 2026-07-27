import { Button } from '@/components/ui/button';

type GamesSelectionToolbarProps = {
    selectedCount: number;
    busy: boolean;
    hasGames: boolean;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onReevaluate: () => void;
    onDelete: () => void;
};

export function GamesSelectionToolbar({
    selectedCount,
    busy,
    hasGames,
    onSelectAll,
    onDeselectAll,
    onReevaluate,
    onDelete,
}: GamesSelectionToolbarProps) {
    if (selectedCount === 0) return null;

    return (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
            <div className="text-sm text-muted-foreground">
                {selectedCount} selected
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    onClick={onSelectAll}
                    disabled={busy || !hasGames}
                >
                    Select all
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={onDeselectAll}
                    disabled={busy || !hasGames}
                >
                    Deselect all
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={onReevaluate}
                    disabled={busy || selectedCount === 0}
                >
                    Reevaluate
                </Button>
                <Button
                    type="button"
                    variant="destructive"
                    onClick={onDelete}
                    disabled={busy || selectedCount === 0}
                >
                    Delete
                </Button>
            </div>
        </div>
    );
}
