export const ANALYSIS_QUALITIES = ['STANDARD', 'THOROUGH'] as const;

export type AnalysisQuality = (typeof ANALYSIS_QUALITIES)[number];
export const ANALYSIS_QUALITY_PROFILE_VERSION = 1;

export type AnalysisQualityProfile = {
    quality: AnalysisQuality;
    label: string;
    description: string;
    serverCreditsPerGame: number;
    nodesPerPosition: number;
    confirmationNodes: number;
    maxConfirmationNodes: number;
    verificationNodesPerPosition: number;
};

export const DEFAULT_ANALYSIS_QUALITY: AnalysisQuality = 'THOROUGH';

export const ANALYSIS_QUALITY_PROFILES: Record<
    AnalysisQuality,
    AnalysisQualityProfile
> = {
    STANDARD: {
        quality: 'STANDARD',
        label: 'Standard',
        description: 'Faster analysis with strong verification.',
        serverCreditsPerGame: 7,
        nodesPerPosition: 100_000,
        confirmationNodes: 200_000,
        maxConfirmationNodes: 800_000,
        verificationNodesPerPosition: 100_000,
    },
    THOROUGH: {
        quality: 'THOROUGH',
        label: 'Thorough',
        description: 'Recommended. Resolves more difficult positions.',
        serverCreditsPerGame: 10,
        nodesPerPosition: 100_000,
        confirmationNodes: 200_000,
        maxConfirmationNodes: 1_600_000,
        verificationNodesPerPosition: 100_000,
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
