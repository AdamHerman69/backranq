import type { MAIA_MODEL } from '@/lib/coach/maia/metadata';

export type MaiaEnginePhase =
    | 'idle'
    | 'checking-cache'
    | 'downloading'
    | 'verifying'
    | 'loading'
    | 'ready'
    | 'error'
    | 'terminated';

export type MaiaModelSource = 'cache' | 'network' | null;

export type MaiaErrorCode =
    | 'ABORTED'
    | 'BAD_REQUEST'
    | 'CACHE_ERROR'
    | 'DOWNLOAD_FAILED'
    | 'INTEGRITY_FAILED'
    | 'INTEGRITY_UNAVAILABLE'
    | 'MODEL_LOAD_FAILED'
    | 'MODEL_NOT_CACHED'
    | 'MODEL_UNAVAILABLE_OFFLINE'
    | 'NOT_READY'
    | 'RUNTIME_ERROR'
    | 'TERMINATED'
    | 'TIMEOUT'
    | 'WORKER_ERROR';

export type MaiaEngineStatus = {
    phase: MaiaEnginePhase;
    /** A normalized 0..1 download progress, or null when indeterminate. */
    progress: number | null;
    source: MaiaModelSource;
    /** True only when both model and runtime assets survived persistent writes. */
    offlineReady?: boolean;
    message: string;
    errorCode?: MaiaErrorCode;
};

export type MaiaProgressCallback = (status: MaiaEngineStatus) => void;

export type MaiaInitializeOptions = {
    /** False guarantees that initialization will not fetch missing assets. */
    allowDownload?: boolean;
    /** Bypass saved runtime assets and repair them from immutable sources. */
    forceRefresh?: boolean;
    onProgress?: MaiaProgressCallback;
    signal?: AbortSignal;
};

export type MaiaMoveRequest = {
    fen: string;
    selfElo: number;
    opponentElo: number;
    /** Any finite number; it is normalized to an unsigned 32-bit seed. */
    seed: number;
    signal?: AbortSignal;
};

export type MaiaMoveCandidate = {
    moveUci: string;
    probability: number;
};

export type MaiaMoveResult = {
    moveUci: string;
    /** Probability after legal masking, temperature and top-p truncation. */
    probability: number;
    candidateCount: number;
    modelId: typeof MAIA_MODEL.id;
    modelVersion: typeof MAIA_MODEL.version;
    engineRevision: typeof MAIA_MODEL.engineRevision;
    samplerVersion: typeof MAIA_MODEL.samplerVersion;
    seed: number;
    /**
     * Highest-probability moves from the sampled nucleus. Tactical guard uses
     * the original Maia weights for conditional resampling after verification.
     */
    candidates: MaiaMoveCandidate[];
};

export class MaiaOpponentError extends Error {
    readonly code: MaiaErrorCode;
    readonly recoverable: boolean;

    constructor(
        code: MaiaErrorCode,
        message: string,
        options?: {
            cause?: unknown;
            recoverable?: boolean;
        }
    ) {
        super(message, { cause: options?.cause });
        this.name = 'MaiaOpponentError';
        this.code = code;
        this.recoverable = options?.recoverable ?? true;
    }
}
