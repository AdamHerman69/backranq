import * as ort from 'onnxruntime-web/wasm';

import {
    isCompatibleMaiaCacheEntry,
    MAIA_CACHE_DATABASE,
    MAIA_CACHE_KEY,
    MAIA_CACHE_STORE,
    MAIA_CACHE_VERSION,
    type MaiaCachedModel,
} from '@/lib/coach/maia/cache';
import {
    MAIA_MODEL,
    MAIA_RUNTIME_FILES,
    maiaRuntimeAssetUrl,
    maiaRuntimeRefreshUrl,
} from '@/lib/coach/maia/metadata';
import {
    MAIA_MOVE_VOCABULARY_SIZE,
} from '@/lib/coach/maia/preprocess';
import type {
    MaiaSerializedError,
    MaiaWorkerRequest,
    MaiaWorkerResponse,
} from '@/lib/coach/maia/protocol';
import { sampleMaiaPolicy } from '@/lib/coach/maia/sampling';
import type {
    MaiaEngineStatus,
    MaiaErrorCode,
    MaiaModelSource,
    MaiaMoveResult,
} from '@/lib/coach/maia/types';

type WorkerScope = {
    caches?: CacheStorage;
    indexedDB?: IDBFactory;
    crypto?: Crypto;
    location?: WorkerLocation;
    navigator?: {
        onLine?: boolean;
    };
    onmessage: ((event: MessageEvent<MaiaWorkerRequest>) => void) | null;
    postMessage(message: MaiaWorkerResponse): void;
};

const scope = self as unknown as WorkerScope;

function absoluteRuntimeAssetUrl(
    fileName: Parameters<typeof maiaRuntimeAssetUrl>[0]
): string {
    const origin = scope.location?.origin;
    if (!origin || origin === 'null') {
        throw new MaiaWorkerFault(
            'RUNTIME_ERROR',
            'Could not resolve the Backranq runtime origin.'
        );
    }
    return new URL(
        maiaRuntimeAssetUrl(fileName),
        origin
    ).href;
}

function absoluteRuntimeRefreshUrl(
    fileName: Parameters<typeof maiaRuntimeRefreshUrl>[0]
): string {
    const origin = scope.location?.origin;
    if (!origin || origin === 'null') {
        throw new MaiaWorkerFault(
            'RUNTIME_ERROR',
            'Could not resolve the Backranq runtime origin.'
        );
    }
    return new URL(
        maiaRuntimeRefreshUrl(fileName),
        origin
    ).href;
}

class MaiaWorkerFault extends Error {
    readonly code: MaiaErrorCode;
    readonly recoverable: boolean;

    constructor(
        code: MaiaErrorCode,
        message: string,
        recoverable = true,
        cause?: unknown
    ) {
        super(message, { cause });
        this.name = 'MaiaWorkerFault';
        this.code = code;
        this.recoverable = recoverable;
    }
}

let session: ort.InferenceSession | null = null;
let initialization: Promise<MaiaEngineStatus> | null = null;
let initializationAllowDownload: boolean | null = null;
let modelSource: MaiaModelSource = null;
let inferenceQueue: Promise<void> = Promise.resolve();
let status: MaiaEngineStatus = {
    phase: 'idle',
    progress: null,
    source: null,
    message: 'Maia has not been loaded.',
};

function post(message: MaiaWorkerResponse): void {
    scope.postMessage(message);
}

function publishStatus(
    next: MaiaEngineStatus,
    requestId: string | null = null
): MaiaEngineStatus {
    status = next;
    post({
        type: 'status',
        requestId,
        status,
    });
    return status;
}

function serializedError(error: unknown): MaiaSerializedError {
    if (error instanceof MaiaWorkerFault) {
        return {
            code: error.code,
            message: error.message,
            recoverable: error.recoverable,
        };
    }
    return {
        code: 'RUNTIME_ERROR',
        message:
            error instanceof Error
                ? error.message
                : 'Unexpected Maia runtime error.',
        recoverable: true,
    };
}

function postError(id: string | null, error: unknown): void {
    const serialized = serializedError(error);
    status = {
        phase: 'error',
        progress: null,
        source: modelSource,
        message: serialized.message,
        errorCode: serialized.code,
    };
    post({
        type: 'error',
        id,
        error: serialized,
        status,
    });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(request.error ?? new Error('IndexedDB request failed.'));
    });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
            reject(transaction.error ?? new Error('IndexedDB failed.'));
        transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB aborted.'));
    });
}

async function openCache(): Promise<IDBDatabase | null> {
    if (!scope.indexedDB) return null;
    return new Promise((resolve, reject) => {
        const request = scope.indexedDB!.open(
            MAIA_CACHE_DATABASE,
            MAIA_CACHE_VERSION
        );
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(MAIA_CACHE_STORE)) {
                database.createObjectStore(MAIA_CACHE_STORE, {
                    keyPath: 'key',
                });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(request.error ?? new Error('Could not open model cache.'));
        request.onblocked = () =>
            reject(new Error('Opening the Maia model cache was blocked.'));
    });
}

async function readCache(
    database: IDBDatabase
): Promise<MaiaCachedModel | null> {
    const transaction = database.transaction(MAIA_CACHE_STORE, 'readonly');
    const result = await requestResult(
        transaction.objectStore(MAIA_CACHE_STORE).get(MAIA_CACHE_KEY)
    );
    await transactionComplete(transaction);
    if (!result || typeof result !== 'object') return null;
    return result as MaiaCachedModel;
}

async function writeCache(
    database: IDBDatabase,
    bytes: ArrayBuffer
): Promise<void> {
    const transaction = database.transaction(MAIA_CACHE_STORE, 'readwrite');
    transaction.objectStore(MAIA_CACHE_STORE).put({
        key: MAIA_CACHE_KEY,
        modelId: MAIA_MODEL.id,
        modelVersion: MAIA_MODEL.version,
        sha256: MAIA_MODEL.sha256,
        byteLength: bytes.byteLength,
        bytes,
        cachedAt: Date.now(),
    } satisfies MaiaCachedModel);
    await transactionComplete(transaction);
}

async function deleteCache(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction(MAIA_CACHE_STORE, 'readwrite');
    transaction.objectStore(MAIA_CACHE_STORE).delete(MAIA_CACHE_KEY);
    await transactionComplete(transaction);
}

async function pruneStaleModels(
    database: IDBDatabase
): Promise<void> {
    const transaction = database.transaction(
        MAIA_CACHE_STORE,
        'readwrite'
    );
    const store = transaction.objectStore(MAIA_CACHE_STORE);
    const keys = await requestResult(store.getAllKeys());
    for (const key of keys) {
        if (key !== MAIA_CACHE_KEY) {
            store.delete(key);
        }
    }
    await transactionComplete(transaction);
}

async function persistRuntimeAssets(
    allowDownload: boolean
): Promise<boolean> {
    if (!scope.caches) return false;
    try {
        const cacheNames = await scope.caches.keys();
        await Promise.all(
            cacheNames
                .filter(
                    (cacheName) =>
                        cacheName.startsWith(
                            'coach-maia-runtime-'
                        ) &&
                        cacheName !==
                            MAIA_MODEL.runtimeCacheName
                )
                .map((cacheName) =>
                    scope.caches!.delete(cacheName)
                )
        );
        const cache = await scope.caches.open(
            MAIA_MODEL.runtimeCacheName
        );
        const assetUrls = [
            absoluteRuntimeAssetUrl('backranq-maia.worker.js'),
            absoluteRuntimeAssetUrl('ort-wasm-simd-threaded.mjs'),
            absoluteRuntimeAssetUrl('ort-wasm-simd-threaded.wasm'),
        ];
        for (const [index, assetUrl] of assetUrls.entries()) {
            const cached = await cache.match(assetUrl);
            if (cached && (!allowDownload || index === 0)) {
                continue;
            }
            if (!allowDownload) return false;
            await cache.delete(assetUrl);
            const response = await fetch(
                absoluteRuntimeRefreshUrl(
                    MAIA_RUNTIME_FILES[index]!
                ),
                {
                    cache: 'no-store',
                    credentials: 'same-origin',
                }
            );
            if (!response.ok) return false;
            await cache.put(assetUrl, response);
        }
        return true;
    } catch {
        return false;
    }
}

async function readCachedRuntime(): Promise<{
    mjsUrl: string;
    wasmBinary: Uint8Array;
} | null> {
    if (!scope.caches) return null;
    try {
        const cache = await scope.caches.open(
            MAIA_MODEL.runtimeCacheName
        );
        const [mjsResponse, wasmResponse] = await Promise.all([
            cache.match(
                absoluteRuntimeAssetUrl(
                    'ort-wasm-simd-threaded.mjs'
                )
            ),
            cache.match(
                absoluteRuntimeAssetUrl(
                    'ort-wasm-simd-threaded.wasm'
                )
            ),
        ]);
        if (!mjsResponse || !wasmResponse) return null;
        return {
            mjsUrl: URL.createObjectURL(await mjsResponse.blob()),
            wasmBinary: new Uint8Array(
                await wasmResponse.arrayBuffer()
            ),
        };
    } catch {
        return null;
    }
}

function bytesToHex(bytes: Uint8Array): string {
    let result = '';
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, '0');
    }
    return result;
}

async function verifyModel(bytes: ArrayBuffer): Promise<void> {
    const subtle = scope.crypto?.subtle;
    if (!subtle) {
        throw new MaiaWorkerFault(
            'INTEGRITY_UNAVAILABLE',
            'This browser cannot verify the Maia model.',
            false
        );
    }
    if (bytes.byteLength !== MAIA_MODEL.byteLength) {
        throw new MaiaWorkerFault(
            'INTEGRITY_FAILED',
            `Maia model size mismatch: expected ${MAIA_MODEL.byteLength} bytes, received ${bytes.byteLength}.`,
            false
        );
    }
    const digest = bytesToHex(
        new Uint8Array(await subtle.digest('SHA-256', bytes))
    );
    if (digest !== MAIA_MODEL.sha256) {
        throw new MaiaWorkerFault(
            'INTEGRITY_FAILED',
            'Maia model checksum verification failed.',
            false
        );
    }
}

async function downloadModel(): Promise<ArrayBuffer> {
    let response: Response;
    try {
            response = await fetch(MAIA_MODEL.sourceUrl, {
                cache: 'no-store',
                credentials: 'omit',
                mode: 'cors',
                referrerPolicy: 'no-referrer',
            });
    } catch (error) {
        const offline = scope.navigator?.onLine === false;
        throw new MaiaWorkerFault(
            offline ? 'MODEL_UNAVAILABLE_OFFLINE' : 'DOWNLOAD_FAILED',
            offline
                ? 'Maia is not downloaded yet and the browser is offline.'
                : 'Could not download the Maia model.',
            true,
            error
        );
    }
    if (!response.ok) {
        throw new MaiaWorkerFault(
            'DOWNLOAD_FAILED',
            `Maia model download failed with HTTP ${response.status}.`
        );
    }
    if (!response.body) {
        throw new MaiaWorkerFault(
            'DOWNLOAD_FAILED',
            'The Maia model response did not contain a readable body.'
        );
    }

    const advertisedLength = Number(response.headers.get('content-length'));
    if (
        Number.isFinite(advertisedLength) &&
        advertisedLength > 0 &&
        advertisedLength !== MAIA_MODEL.byteLength
    ) {
        throw new MaiaWorkerFault(
            'INTEGRITY_FAILED',
            `Maia model Content-Length mismatch: expected ${MAIA_MODEL.byteLength}, received ${advertisedLength}.`,
            false
        );
    }

    const bytes = new Uint8Array(MAIA_MODEL.byteLength);
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (received + chunk.value.byteLength > bytes.byteLength) {
            await reader.cancel();
            throw new MaiaWorkerFault(
                'INTEGRITY_FAILED',
                'The Maia model response was larger than expected.',
                false
            );
        }
        bytes.set(chunk.value, received);
        received += chunk.value.byteLength;
        publishStatus({
            phase: 'downloading',
            progress: received / MAIA_MODEL.byteLength,
            source: 'network',
            message: `Downloading Maia (${Math.round(
                (received / MAIA_MODEL.byteLength) * 100
            )}%).`,
        });
    }
    if (received !== MAIA_MODEL.byteLength) {
        throw new MaiaWorkerFault(
            'INTEGRITY_FAILED',
            `Maia model download ended at ${received} of ${MAIA_MODEL.byteLength} bytes.`,
            false
        );
    }
    return bytes.buffer;
}

async function loadVerifiedModel(
    allowDownload: boolean
): Promise<MaiaEngineStatus> {
    publishStatus({
        phase: 'checking-cache',
        progress: null,
        source: null,
        message: 'Checking the offline Maia model.',
    });

    let database: IDBDatabase | null = null;
    let cached: MaiaCachedModel | null = null;
    let modelPersisted = false;
    try {
        database = await openCache();
        if (database) {
            await pruneStaleModels(database);
            cached = await readCache(database);
        }
    } catch {
        database?.close();
        database = null;
    }

    let bytes: ArrayBuffer | null = null;
    try {
        if (cached && isCompatibleMaiaCacheEntry(cached)) {
            modelSource = 'cache';
            publishStatus({
                phase: 'verifying',
                progress: null,
                source: 'cache',
                message: 'Verifying the cached Maia model.',
            });
            try {
                await verifyModel(cached.bytes);
                bytes = cached.bytes;
                modelPersisted = true;
            } catch {
                if (database) {
                    try {
                        await deleteCache(database);
                    } catch {
                        // A broken cache must never be used, even if deletion fails.
                    }
                }
                cached = null;
                bytes = null;
            }
        } else if (cached && database) {
            try {
                await deleteCache(database);
            } catch {
                // Metadata mismatch already makes this entry unusable.
            }
        }

        if (!bytes) {
            if (!allowDownload) {
                modelSource = null;
                throw new MaiaWorkerFault(
                    'MODEL_NOT_CACHED',
                    'The saved Maia model is missing or invalid. Download Maia again to replace it.'
                );
            }
            modelSource = 'network';
            publishStatus({
                phase: 'downloading',
                progress: 0,
                source: 'network',
                message: 'Downloading Maia for offline play.',
            });
            bytes = await downloadModel();
            publishStatus({
                phase: 'verifying',
                progress: null,
                source: 'network',
                message: 'Verifying the downloaded Maia model.',
            });
            await verifyModel(bytes);
            if (database) {
                try {
                    await writeCache(database, bytes);
                    const written = await readCache(database);
                    modelPersisted =
                        written !== null &&
                        isCompatibleMaiaCacheEntry(written);
                } catch {
                    // Inference may proceed, but this browser will need to download
                    // again next time. Integrity was already verified above.
                }
            }
        }
    } finally {
        database?.close();
    }
    const runtimePersisted =
        await persistRuntimeAssets(allowDownload);
    if (!runtimePersisted && !allowDownload) {
        throw new MaiaWorkerFault(
            'MODEL_NOT_CACHED',
            'The saved Maia runtime is incomplete. Download Maia again to replace it.'
        );
    }

    publishStatus({
        phase: 'loading',
        progress: null,
        source: modelSource,
        message: 'Starting the Maia engine.',
    });
    const localRuntime = await readCachedRuntime();
    if (!localRuntime) {
        throw new MaiaWorkerFault(
            allowDownload ? 'CACHE_ERROR' : 'MODEL_NOT_CACHED',
            allowDownload
                ? 'The freshly downloaded Maia runtime could not be read from local storage.'
                : 'The saved Maia runtime could not be read. Download Maia again to replace it.'
        );
    }
    try {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = {
            mjs: localRuntime.mjsUrl,
        };
        ort.env.wasm.wasmBinary =
            localRuntime.wasmBinary;
        session = await ort.InferenceSession.create(bytes, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
    } catch (error) {
        throw new MaiaWorkerFault(
            'MODEL_LOAD_FAILED',
            'The verified Maia model could not be loaded.',
            true,
            error
        );
    } finally {
        URL.revokeObjectURL(localRuntime.mjsUrl);
    }
    return publishStatus({
        phase: 'ready',
        progress: 1,
        source: modelSource,
        offlineReady: modelPersisted && runtimePersisted,
        message:
            modelPersisted && runtimePersisted
                ? modelSource === 'cache'
                    ? 'Maia is ready offline.'
                    : 'Maia is ready and saved for offline play.'
                : 'Maia is ready for this session, but could not be saved offline.',
    });
}

function ensureInitialized(
    allowDownload: boolean
): Promise<MaiaEngineStatus> {
    if (session && status.phase === 'ready') {
        return Promise.resolve(status);
    }
    if (initialization) {
        if (initializationAllowDownload !== allowDownload) {
            return Promise.reject(
                new MaiaWorkerFault(
                    'BAD_REQUEST',
                    'Maia initialization is already running with different download permission.'
                )
            );
        }
        return initialization;
    }
    initializationAllowDownload = allowDownload;
    initialization = loadVerifiedModel(allowDownload).finally(() => {
        initialization = null;
        initializationAllowDownload = null;
    });
    return initialization;
}

function validateMovePayload(message: Extract<
    MaiaWorkerRequest,
    { type: 'select-move' }
>): void {
    if (
        !(message.tokens instanceof Float32Array) ||
        message.tokens.length !== 64 * 12 ||
        !Array.isArray(message.legalMoves) ||
        message.legalMoves.length === 0
    ) {
        throw new MaiaWorkerFault(
            'BAD_REQUEST',
            'Invalid Maia position payload.'
        );
    }
    const seen = new Set<number>();
    for (const move of message.legalMoves) {
        if (
            !move ||
            !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.moveUci) ||
            !Number.isSafeInteger(move.modelIndex) ||
            move.modelIndex < 0 ||
            move.modelIndex >= MAIA_MOVE_VOCABULARY_SIZE ||
            seen.has(move.modelIndex)
        ) {
            throw new MaiaWorkerFault(
                'BAD_REQUEST',
                'Invalid or duplicate legal Maia move.'
            );
        }
        seen.add(move.modelIndex);
    }
}

async function selectMove(
    message: Extract<MaiaWorkerRequest, { type: 'select-move' }>
): Promise<MaiaMoveResult> {
    if (!session || status.phase !== 'ready') {
        throw new MaiaWorkerFault(
            'NOT_READY',
            'Initialize Maia before requesting a move.'
        );
    }
    validateMovePayload(message);

    let outputs: ort.InferenceSession.OnnxValueMapType;
    try {
        outputs = await session.run({
            tokens: new ort.Tensor('float32', message.tokens, [1, 64, 12]),
            elo_self: new ort.Tensor(
                'float32',
                Float32Array.of(message.selfElo),
                [1]
            ),
            elo_oppo: new ort.Tensor(
                'float32',
                Float32Array.of(message.opponentElo),
                [1]
            ),
        });
    } catch (error) {
        throw new MaiaWorkerFault(
            'RUNTIME_ERROR',
            'Maia inference failed.',
            true,
            error
        );
    }

    const policy = outputs.logits_move;
    if (!policy || policy.data.length !== MAIA_MOVE_VOCABULARY_SIZE) {
        throw new MaiaWorkerFault(
            'RUNTIME_ERROR',
            'Maia returned an unexpected policy tensor.',
            false
        );
    }
    const sample = sampleMaiaPolicy({
        logits: policy.data as ArrayLike<number>,
        legalMoves: message.legalMoves,
        seed: message.seed,
        temperature: MAIA_MODEL.sampling.temperature,
        topP: MAIA_MODEL.sampling.topP,
    });
    return {
        moveUci: sample.moveUci,
        probability: sample.probability,
        candidateCount: sample.candidateCount,
        modelId: MAIA_MODEL.id,
        modelVersion: MAIA_MODEL.version,
        engineRevision: MAIA_MODEL.engineRevision,
        samplerVersion: MAIA_MODEL.samplerVersion,
        seed: sample.seed,
    };
}

scope.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') {
        postError(
            null,
            new MaiaWorkerFault('BAD_REQUEST', 'Invalid Maia worker request.')
        );
        return;
    }

    if (message.type === 'initialize') {
        ensureInitialized(message.allowDownload === true)
            .then((readyStatus) => {
                post({
                    type: 'initialized',
                    id: message.id,
                    status: readyStatus,
                });
            })
            .catch((error) => {
                postError(message.id, error);
            });
        return;
    }

    if (message.type === 'select-move') {
        inferenceQueue = inferenceQueue
            .then(async () => {
                const result = await selectMove(message);
                post({
                    type: 'move',
                    id: message.id,
                    result,
                });
            })
            .catch((error) => {
                postError(message.id, error);
            });
        return;
    }

    postError(
        null,
        new MaiaWorkerFault('BAD_REQUEST', 'Unknown Maia worker request.')
    );
};
