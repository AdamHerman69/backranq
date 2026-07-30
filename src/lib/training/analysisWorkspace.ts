export {
    engineScoreForWhite,
    engineWdlForWhite,
    formatEngineScoreForWhite,
    formatEngineWdlForWhite,
    whiteExpectedScore,
} from '@/lib/analysis/evaluation';

export const TRAINING_ANALYSIS_MAX_DEPTH = 24;
export const TRAINING_ANALYSIS_MAX_TIME_MS = 120_000;
export const TRAINING_ANALYSIS_DEFAULT_MULTIPV = 3;
