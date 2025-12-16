'use client';

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
        <div
            style={{
                border: '1px solid var(--border, #e6e6e6)',
                borderRadius: 12,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontWeight: 650 }}>
                    Analyzing… {state.phase ? <span style={{ opacity: 0.7 }}>({state.phase})</span> : null}
                </div>
                {onCancel ? (
                    <button
                        type="button"
                        onClick={onCancel}
                        style={{
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid var(--border, #e6e6e6)',
                            background: 'transparent',
                            fontWeight: 600,
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                ) : null}
            </div>

            <div style={{ fontSize: 12, opacity: 0.8 }}>{state.label}</div>

            <div
                style={{
                    height: 10,
                    borderRadius: 999,
                    border: '1px solid var(--border, #e6e6e6)',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        height: '100%',
                        width: `${Math.max(0, Math.min(100, state.percent))}%`,
                        background: 'rgba(123, 97, 255, 0.6)',
                    }}
                />
            </div>
        </div>
    );
}


