import {
    resolveTrainingConfig,
    type ResolvedTrainingConfig,
    type TrainingConfigInput,
} from '@/lib/training/config';
import { hashCanonicalTrainingValue } from '@/lib/training/contractHashes.server';

export function trainingConfigHash(
    config: TrainingConfigInput | ResolvedTrainingConfig
): string {
    return hashCanonicalTrainingValue(resolveTrainingConfig(config));
}
