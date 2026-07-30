'use client';

import {
    MAIA_ELO_MAX,
    MAIA_ELO_MIN,
    MAIA_MODEL,
    maiaRuntimeAssetUrl,
    maiaRuntimeRefreshUrl,
} from '@/lib/coach/maia/metadata';
import { prepareMaiaPosition } from '@/lib/coach/maia/preprocess';
import type {
    MaiaSerializedError,
    MaiaWorkerRequest,
    MaiaWorkerResponse,
} from '@/lib/coach/maia/protocol';
import { normalizeMaiaSeed } from '@/lib/coach/maia/sampling';
import {
    MaiaOpponentError,
    type MaiaEngineStatus,
    type MaiaInitializeOptions,
    type MaiaMoveRequest,
    type MaiaMoveResult,
} from '@/lib/coach/maia/types';

const INITIALIZE_TIMEOUT_MS = 180_000;
const MOVE_TIMEOUT_MS = 30_000;

type PendingRequest =
    | {
          kind: 'initialize';
          resolve: (status: MaiaEngineStatus) => void;
          reject: (error: Error) => void;
          onProgress?: MaiaInitializeOptions['onProgress'];
          timeoutId: ReturnType<typeof setTimeout>;
          abortCleanup?: () => void;
      }
    | {
          kind: 'move';
          resolve: (result: MaiaMoveResult) => void;
          reject: (error: Error) => void;
          timeoutId: ReturnType<typeof setTimeout>;
          abortCleanup?: () => void;
      };

let requestSequence = 0;

function requestId(): string {
    requestSequence += 1;
    return `maia-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function idleStatus(): MaiaEngineStatus {
    return {
        phase: 'idle',
        progress: null,
        source: null,
        message: 'Maia has not been loaded.',
    };
}

function deserializeError(error: MaiaSerializedError): MaiaOpponentError {
    return new MaiaOpponentError(error.code, error.message, {
        recoverable: error.recoverable,
    });
}

export class MaiaOpponentClient {
    private worker: Worker | null = null;
    private workerObjectUrl: string | null = null;
    private workerPreparation: Promise<Worker> | null = null;
    private status = idleStatus();
    private pending = new Map<string, PendingRequest>();
    private initializationPermission: boolean | null = null;
    private terminated = false;

    getStatus(): MaiaEngineStatus {
        return { ...this.status };
    }

    initialize(
        options: MaiaInitializeOptions = {}
    ): Promise<MaiaEngineStatus> {
        if (this.terminated) {
            return Promise.reject(
                new MaiaOpponentError('TERMINATED', 'Maia was terminated.', {
                    recoverable: false,
                })
            );
        }
        if (options.signal?.aborted) {
            return Promise.reject(
                new MaiaOpponentError('ABORTED', 'Maia loading was aborted.')
            );
        }
        if (this.status.phase === 'ready') {
            options.onProgress?.(this.getStatus());
            return Promise.resolve(this.getStatus());
        }
        const allowDownload = options.allowDownload === true;
        if (
            this.initializationPermission !== null &&
            this.initializationPermission !== allowDownload
        ) {
            return Promise.reject(
                new MaiaOpponentError(
                    'BAD_REQUEST',
                    'Maia initialization is already running with different download permission.'
                )
            );
        }
        this.initializationPermission = allowDownload;

        const id = requestId();
        return new Promise<MaiaEngineStatus>((resolve, reject) => {
            const pending: PendingRequest = {
                kind: 'initialize',
                resolve,
                reject,
                onProgress: options.onProgress,
                timeoutId: setTimeout(() => {
                    this.failAll(
                        new MaiaOpponentError(
                            'TIMEOUT',
                            'Maia model loading timed out.'
                        )
                    );
                }, INITIALIZE_TIMEOUT_MS),
            };
            this.pending.set(id, pending);
            this.installAbort(id, options.signal, 'Maia loading was aborted.');
            try {
                const message: MaiaWorkerRequest = {
                    type: 'initialize',
                    id,
                    allowDownload,
                };
                void this.prepareWorker(allowDownload)
                        .then((worker) => {
                            if (this.pending.has(id)) {
                                worker.postMessage(message);
                            }
                        })
                        .catch((error) => {
                            if (this.terminated) return;
                            this.failAll(
                                error instanceof MaiaOpponentError
                                    ? error
                                    : new MaiaOpponentError(
                                          'WORKER_ERROR',
                                          'Could not start the Maia worker.',
                                          { cause: error }
                                      )
                            );
                        });
            } catch (error) {
                this.failAll(
                    new MaiaOpponentError(
                        'WORKER_ERROR',
                        'Could not start the Maia worker.',
                        { cause: error }
                    )
                );
            }
        });
    }

    selectMove(request: MaiaMoveRequest): Promise<MaiaMoveResult> {
        if (this.terminated) {
            return Promise.reject(
                new MaiaOpponentError('TERMINATED', 'Maia was terminated.', {
                    recoverable: false,
                })
            );
        }
        if (this.status.phase !== 'ready' || !this.worker) {
            return Promise.reject(
                new MaiaOpponentError(
                    'NOT_READY',
                    'Initialize Maia before requesting a move.'
                )
            );
        }
        if (request.signal?.aborted) {
            return Promise.reject(
                new MaiaOpponentError('ABORTED', 'Maia move was aborted.')
            );
        }
        if (
            !Number.isFinite(request.selfElo) ||
            !Number.isFinite(request.opponentElo) ||
            request.selfElo < MAIA_ELO_MIN ||
            request.selfElo > MAIA_ELO_MAX ||
            request.opponentElo < MAIA_ELO_MIN ||
            request.opponentElo > MAIA_ELO_MAX
        ) {
            return Promise.reject(
                new MaiaOpponentError(
                    'BAD_REQUEST',
                    `Maia Elo must be between ${MAIA_ELO_MIN} and ${MAIA_ELO_MAX}.`
                )
            );
        }

        let position;
        let seed;
        try {
            position = prepareMaiaPosition(request.fen);
            seed = normalizeMaiaSeed(request.seed);
        } catch (error) {
            return Promise.reject(
                new MaiaOpponentError(
                    'BAD_REQUEST',
                    error instanceof Error
                        ? error.message
                        : 'Invalid Maia move request.',
                    { cause: error }
                )
            );
        }

        const id = requestId();
        return new Promise<MaiaMoveResult>((resolve, reject) => {
            const pending: PendingRequest = {
                kind: 'move',
                resolve,
                reject,
                timeoutId: setTimeout(() => {
                    this.failAll(
                        new MaiaOpponentError(
                            'TIMEOUT',
                            'Maia move generation timed out.'
                        )
                    );
                }, MOVE_TIMEOUT_MS),
            };
            this.pending.set(id, pending);
            this.installAbort(id, request.signal, 'Maia move was aborted.');
            const message: MaiaWorkerRequest = {
                type: 'select-move',
                id,
                tokens: position.tokens,
                legalMoves: position.legalMoves,
                selfElo: Math.trunc(request.selfElo),
                opponentElo: Math.trunc(request.opponentElo),
                seed,
            };
            this.worker!.postMessage(message, [position.tokens.buffer]);
        });
    }

    terminate(): void {
        if (this.terminated) return;
        this.terminated = true;
        this.worker?.terminate();
        this.worker = null;
        this.revokeWorkerObjectUrl();
        const error = new MaiaOpponentError(
            'TERMINATED',
            'Maia was terminated.',
            { recoverable: false }
        );
        for (const id of this.pending.keys()) {
            this.rejectPending(id, error);
        }
        this.status = {
            phase: 'terminated',
            progress: null,
            source: null,
            message: 'Maia was terminated.',
            errorCode: 'TERMINATED',
        };
    }

    /**
     * Stop the client and wait until any worker bootstrap has finished.
     * Callers deleting offline data must use this barrier so an in-flight
     * download cannot recreate a cache after deletion completes.
     */
    async terminateAndWait(): Promise<void> {
        this.terminate();
        const preparation = this.workerPreparation;
        if (!preparation) return;
        try {
            await preparation;
        } catch {
            // Termination intentionally makes preparation fail.
        }
    }

    private prepareWorker(
        allowDownload: boolean
    ): Promise<Worker> {
        if (this.worker) return Promise.resolve(this.worker);
        if (this.workerPreparation) return this.workerPreparation;
        const operation = (
            allowDownload
                ? this.downloadWorker()
                : this.loadCachedWorker()
        ).finally(() => {
            if (this.workerPreparation === operation) {
                this.workerPreparation = null;
            }
        });
        this.workerPreparation = operation;
        return operation;
    }

    private async downloadWorker(): Promise<Worker> {
        if (typeof Worker === 'undefined') {
            throw new Error('Web Workers are not available in this browser.');
        }
        if (typeof caches === 'undefined') {
            throw new MaiaOpponentError(
                'CACHE_ERROR',
                'This browser cannot save the Maia runtime for offline play.'
            );
        }
        const workerUrl = maiaRuntimeAssetUrl(
            'backranq-maia.worker.js'
        );
        await caches.delete(MAIA_MODEL.runtimeCacheName);
        const response = await fetch(
            maiaRuntimeRefreshUrl('backranq-maia.worker.js'),
            {
                cache: 'no-store',
                credentials: 'same-origin',
            }
        );
        if (this.terminated) {
            throw new MaiaOpponentError(
                'TERMINATED',
                'Maia was terminated.',
                { recoverable: false }
            );
        }
        if (!response.ok) {
            throw new MaiaOpponentError(
                'DOWNLOAD_FAILED',
                `Maia worker download failed with HTTP ${response.status}.`
            );
        }
        const cache = await caches.open(
            MAIA_MODEL.runtimeCacheName
        );
        if (this.terminated) {
            throw new MaiaOpponentError(
                'TERMINATED',
                'Maia was terminated.',
                { recoverable: false }
            );
        }
        await cache.put(workerUrl, response.clone());
        if (this.terminated) {
            throw new MaiaOpponentError(
                'TERMINATED',
                'Maia was terminated.',
                { recoverable: false }
            );
        }
        this.workerObjectUrl = URL.createObjectURL(
            await response.blob()
        );
        return this.installWorker(this.workerObjectUrl);
    }

    private async loadCachedWorker(): Promise<Worker> {
        if (this.worker) return this.worker;
        if (typeof Worker === 'undefined') {
            throw new Error('Web Workers are not available in this browser.');
        }
        if (typeof caches === 'undefined') {
            throw new MaiaOpponentError(
                'MODEL_NOT_CACHED',
                'The saved Maia worker is unavailable. Download Maia again to replace it.'
            );
        }
        const workerUrl = maiaRuntimeAssetUrl(
            'backranq-maia.worker.js'
        );
        const cache = await caches.open(
            MAIA_MODEL.runtimeCacheName
        );
        const response = await cache.match(workerUrl);
        if (!response) {
            throw new MaiaOpponentError(
                'MODEL_NOT_CACHED',
                'The saved Maia worker is missing. Download Maia again to replace it.'
            );
        }
        if (this.terminated) {
            throw new MaiaOpponentError(
                'TERMINATED',
                'Maia was terminated.',
                { recoverable: false }
            );
        }
        this.workerObjectUrl = URL.createObjectURL(
            await response.blob()
        );
        return this.installWorker(this.workerObjectUrl);
    }

    private installWorker(constructorUrl: string): Worker {
        if (this.terminated) {
            this.revokeWorkerObjectUrl();
            throw new MaiaOpponentError(
                'TERMINATED',
                'Maia was terminated.',
                { recoverable: false }
            );
        }
        let worker: Worker;
        try {
            worker = new Worker(constructorUrl);
        } catch (error) {
            this.revokeWorkerObjectUrl();
            throw error;
        }
        worker.onmessage = (event: MessageEvent<MaiaWorkerResponse>) => {
            this.onMessage(event.data);
        };
        worker.onerror = (event: ErrorEvent) => {
            this.failAll(
                new MaiaOpponentError(
                    'WORKER_ERROR',
                    event.message || 'The Maia worker crashed.'
                )
            );
        };
        this.worker = worker;
        return worker;
    }

    private revokeWorkerObjectUrl(): void {
        if (!this.workerObjectUrl) return;
        URL.revokeObjectURL(this.workerObjectUrl);
        this.workerObjectUrl = null;
    }

    private installAbort(
        id: string,
        signal: AbortSignal | undefined,
        message: string
    ): void {
        if (!signal) return;
        const onAbort = () => {
            this.rejectPending(id, new MaiaOpponentError('ABORTED', message));
        };
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.abortCleanup = () =>
            signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
    }

    private settlePending(id: string): PendingRequest | null {
        const pending = this.pending.get(id);
        if (!pending) return null;
        this.pending.delete(id);
        if (
            pending.kind === 'initialize' &&
            !Array.from(this.pending.values()).some(
                (candidate) => candidate.kind === 'initialize'
            )
        ) {
            this.initializationPermission = null;
        }
        clearTimeout(pending.timeoutId);
        pending.abortCleanup?.();
        return pending;
    }

    private rejectPending(id: string, error: Error): void {
        this.settlePending(id)?.reject(error);
    }

    private failAll(error: Error): void {
        for (const id of this.pending.keys()) {
            this.rejectPending(id, error);
        }
        this.status = {
            phase: 'error',
            progress: null,
            source: this.status.source,
            message: error.message,
            errorCode:
                error instanceof MaiaOpponentError
                    ? error.code
                    : 'WORKER_ERROR',
        };
        this.worker?.terminate();
        this.worker = null;
        this.revokeWorkerObjectUrl();
    }

    private onMessage(message: MaiaWorkerResponse): void {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'status') {
            this.status = message.status;
            if (message.requestId) {
                const pending = this.pending.get(message.requestId);
                if (pending?.kind === 'initialize') {
                    pending.onProgress?.(this.getStatus());
                }
            } else {
                for (const pending of this.pending.values()) {
                    if (pending.kind === 'initialize') {
                        pending.onProgress?.(this.getStatus());
                    }
                }
            }
            return;
        }
        if (message.type === 'initialized') {
            this.status = message.status;
            const pending = this.settlePending(message.id);
            if (pending?.kind === 'initialize') {
                pending.onProgress?.(this.getStatus());
                pending.resolve(this.getStatus());
            }
            return;
        }
        if (message.type === 'move') {
            const pending = this.settlePending(message.id);
            if (pending?.kind === 'move') {
                pending.resolve(message.result);
            }
            return;
        }

        this.status = message.status;
        const error = deserializeError(message.error);
        if (message.id) {
            const pending = this.pending.get(message.id);
            if (pending?.kind === 'initialize') {
                this.failAll(error);
            } else {
                this.rejectPending(message.id, error);
            }
        } else {
            this.failAll(error);
        }
    }
}
