import type { CSSProperties } from 'react';

import type { TrainingAnalysisPositionContext } from '@/lib/training/analysisTree';

type TrainingAnalysisContextPalette = {
    label: string;
    detail: string;
    saturation: number;
    borderAlpha: number;
    backgroundAlpha: number;
};

const SHARED_HUE = 220;
const ACCENT_LIGHTNESS = 58;

export const TRAINING_ANALYSIS_CONTEXT_PALETTE: Record<
    TrainingAnalysisPositionContext,
    TrainingAnalysisContextPalette
> = {
    source: {
        label: 'Original game',
        detail: 'Reference line',
        saturation: 8,
        borderAlpha: 0.3,
        backgroundAlpha: 0.028,
    },
    decision: {
        label: 'Decision position',
        detail: 'Explore from here',
        saturation: 38,
        borderAlpha: 0.44,
        backgroundAlpha: 0.045,
    },
    analysis: {
        label: 'Analysis variation',
        detail: 'Sandbox',
        saturation: 20,
        borderAlpha: 0.36,
        backgroundAlpha: 0.036,
    },
};

function contextColor(
    context: TrainingAnalysisPositionContext,
    alpha: number,
    lightness = ACCENT_LIGHTNESS
): string {
    const palette = TRAINING_ANALYSIS_CONTEXT_PALETTE[context];
    return `hsl(${SHARED_HUE} ${palette.saturation}% ${lightness}% / ${alpha})`;
}

export function trainingAnalysisFrameStyle(
    context: TrainingAnalysisPositionContext
): CSSProperties {
    const palette = TRAINING_ANALYSIS_CONTEXT_PALETTE[context];
    return {
        borderColor: contextColor(context, palette.borderAlpha),
        backgroundColor: contextColor(
            context,
            palette.backgroundAlpha,
            50
        ),
        boxShadow: `inset 0 0 0 1px ${contextColor(context, 0.045)}`,
    };
}

export function trainingAnalysisChipStyle(
    context: TrainingAnalysisPositionContext
): CSSProperties {
    return {
        borderColor: contextColor(context, 0.28),
        backgroundColor: contextColor(context, 0.09),
    };
}

export function trainingAnalysisDotStyle(
    context: TrainingAnalysisPositionContext
): CSSProperties {
    return {
        backgroundColor: contextColor(context, 0.82),
    };
}

export function trainingAnalysisActiveMoveStyle(
    context: TrainingAnalysisPositionContext
): CSSProperties {
    return {
        backgroundColor: contextColor(context, 0.14),
        boxShadow: `inset 0 0 0 1px ${contextColor(context, 0.24)}`,
    };
}

export function trainingAnalysisTreeStyle(
    context: TrainingAnalysisPositionContext
): CSSProperties {
    return {
        borderColor: contextColor(context, 0.2),
        backgroundColor: contextColor(context, 0.018, 50),
    };
}
