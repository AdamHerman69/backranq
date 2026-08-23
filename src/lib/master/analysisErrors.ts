import { ExactPvUnavailableError } from '@/lib/analysis/serverStockfishErrors';

export type MasterSnapshotFailureKind =
    | 'EXACT_PV_UNAVAILABLE'
    | 'INVALID_ATTRIBUTION'
    | 'INCOMPLETE_RECEIPT';

export class MasterSnapshotAnalysisError extends Error {
    constructor(
        message: string,
        readonly kind: Exclude<
            MasterSnapshotFailureKind,
            'EXACT_PV_UNAVAILABLE'
        >
    ) {
        super(message);
        this.name = 'MasterSnapshotAnalysisError';
    }
}

export function masterSnapshotFailureKind(
    error: unknown
): MasterSnapshotFailureKind | null {
    if (error instanceof ExactPvUnavailableError) {
        return 'EXACT_PV_UNAVAILABLE';
    }
    if (error instanceof MasterSnapshotAnalysisError) return error.kind;
    return null;
}
