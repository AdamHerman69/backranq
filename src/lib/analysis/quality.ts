import { CORROBORATED_SELECTION_POLICY_ID, T2_SELECTION_POLICY_ID, type SelectionPolicyId } from './t2Policy';
export const ANALYSIS_QUALITIES = ['T2', 'STANDARD', 'THOROUGH'] as const;

export type AnalysisQuality = (typeof ANALYSIS_QUALITIES)[number];
export const ANALYSIS_QUALITY_PROFILE_VERSION = 3;

export type AnalysisQualityProfile = {
    quality: AnalysisQuality;
    selectionPolicyId: SelectionPolicyId;
    multiPv: number;
    label: string;
    description: string;
    serverCreditsPerGame: number;
    nodesPerPosition: number;
    confirmationNodes: number;
    maxConfirmationNodes: number;
};

export const DEFAULT_ANALYSIS_QUALITY: AnalysisQuality = 'T2';

export const ANALYSIS_QUALITY_PROFILES: Record<
    AnalysisQuality,
    AnalysisQualityProfile
> = {
    T2: {
        quality: 'T2', selectionPolicyId: T2_SELECTION_POLICY_ID, multiPv: 3,
        label: 'Practice', description: 'Efficient analysis with targeted verification.',
        serverCreditsPerGame: 10, nodesPerPosition: 100_000, confirmationNodes: 200_000, maxConfirmationNodes: 400_000,
    },
    STANDARD: {
        quality: 'STANDARD', selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, multiPv: 5,
        label: 'Standard',
        description: 'Faster analysis with strong verification.',
        serverCreditsPerGame: 7,
        nodesPerPosition: 100_000,
        confirmationNodes: 200_000,
        maxConfirmationNodes: 800_000,
    },
    THOROUGH: {
        quality: 'THOROUGH', selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, multiPv: 5,
        label: 'Thorough',
        description: 'Additional corroboration for difficult positions.',
        serverCreditsPerGame: 10,
        nodesPerPosition: 100_000,
        confirmationNodes: 200_000,
        maxConfirmationNodes: 1_600_000,
    },
};

export function isAnalysisQuality(value: unknown): value is AnalysisQuality {
    return ANALYSIS_QUALITIES.includes(value as AnalysisQuality);
}

export function analysisQualityProfile(
    quality: AnalysisQuality
): AnalysisQualityProfile {
    return ANALYSIS_QUALITY_PROFILES[quality];
}

export function analysisCreditsPerGame(quality: AnalysisQuality): number {
    return analysisQualityProfile(quality).serverCreditsPerGame;
}
