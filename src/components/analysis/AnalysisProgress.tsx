'use client';

import { Button } from '@/components/ui/button';

export type AnalysisProgressState = {
    label: string;
    percent: number; // 0-100
    phase?: string;
};

export function AnalysisProgress({
    state,
    onCancel,
}: {
    state: AnalysisProgressState;
    onCancel?: () => void;
}) {
    return (
        <div className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">
                    Analyzing…{' '}
                    {state.phase ? (
                        <span className="font-normal text-muted-foreground">
                            ({state.phase})
                        </span>
                    ) : null}
                </div>
                {onCancel ? (
                    <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                        Cancel
                    </Button>
                ) : null}
            </div>

            <div className="mt-2 text-sm text-muted-foreground">{state.label}</div>

            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div
                    className="h-2 bg-primary/70"
                    style={{
                        width: `${Math.max(0, Math.min(100, state.percent))}%`,
                    }}
                />
            </div>
        </div>
    );
}


