export const MAIA_ELO_MIN = 0;
export const MAIA_ELO_MAX = 5_000;

export const MAIA_RECOMMENDED_ELO_MIN = 800;
export const MAIA_RECOMMENDED_ELO_MAX = 2_800;
export const MAIA_RECOMMENDED_ELO_DEFAULT = 1_500;

export const MAIA_ENGINE_REVISION =
    'maia3-sf16-v3:405bf76c:worker-v8:prep-v1:mulberry32-p95-t1-v1';

/**
 * The model is prepared automatically after the user selects Maia. Its exact
 * immutable source, size and digest are part of the runtime contract and are
 * checked before the bytes can be cached or passed to ONNX Runtime.
 */
export const MAIA_MODEL = {
    id: 'maia3-simplified-browser',
    displayName: 'Maia 3',
    version: 'maia3-simplified-fp16-v3',
    sourceCommit: '0013cc8e6ec52c88f5b3d694781d4cc8427cb91a',
    sourceUrl:
        'https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/0013cc8e6ec52c88f5b3d694781d4cc8427cb91a/public/maia3/maia3_simplified.onnx',
    sourceRepository:
        'https://github.com/CSSLab/maia-platform-frontend',
    upstreamProject: 'https://github.com/CSSLab/maia3',
    sha256:
        '405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856',
    byteLength: 45_683_686,
    /** Model plus the generated ONNX WebAssembly runtime, rounded up. */
    estimatedDownloadMiB: 56.6,
    inputHistoryPositions: 1,
    runtime: 'onnxruntime-web',
    runtimeVersion: '1.27.0',
    workerVersion: 'backranq-maia-worker-v8',
    preprocessingVersion: 'maia3-current-position-v1',
    engineRevision: MAIA_ENGINE_REVISION,
    runtimeCacheName: `coach-maia-runtime-${MAIA_ENGINE_REVISION}`,
    licenseStatus: 'review-required',
    samplerVersion: 'mulberry32-top-p-v1',
    sampling: {
        temperature: 1,
        topP: 0.95,
    },
} as const;

export const MAIA_RUNTIME_FILES = [
    'backranq-maia.worker.js',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
] as const;

export function maiaRuntimeAssetUrl(
    fileName: (typeof MAIA_RUNTIME_FILES)[number]
): string {
    return `/vendor/maia/${fileName}?v=${encodeURIComponent(
        MAIA_MODEL.engineRevision
    )}`;
}

export function maiaRuntimeRefreshUrl(
    fileName: (typeof MAIA_RUNTIME_FILES)[number]
): string {
    return `${maiaRuntimeAssetUrl(
        fileName
    )}&maia-refresh=${encodeURIComponent(MAIA_MODEL.engineRevision)}`;
}
