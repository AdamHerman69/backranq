import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    MAIA_MODEL,
    MaiaOpponentClient,
    MaiaOpponentError,
} from '@/lib/coach/maia';
import type {
    MaiaWorkerRequest,
    MaiaWorkerResponse,
} from '@/lib/coach/maia/protocol';

class FakeWorker {
    static instances: FakeWorker[] = [];

    readonly url: string;
    readonly messages: MaiaWorkerRequest[] = [];
    terminated = false;
    onmessage: ((event: MessageEvent<MaiaWorkerResponse>) => void) | null =
        null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    constructor(url: string | URL) {
        this.url = String(url);
        FakeWorker.instances.push(this);
    }

    postMessage(message: MaiaWorkerRequest): void {
        this.messages.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(message: MaiaWorkerResponse): void {
        this.onmessage?.({ data: message } as MessageEvent<MaiaWorkerResponse>);
    }
}

const readyStatus = {
    phase: 'ready',
    progress: 1,
    source: 'network',
    message: 'Maia is ready.',
} as const;

async function workerWithMessages(
    index = 0,
    count = 1
): Promise<FakeWorker> {
    await vi.waitFor(() => {
        expect(FakeWorker.instances.length).toBeGreaterThan(index);
        expect(
            FakeWorker.instances[index]!.messages.length
        ).toBeGreaterThanOrEqual(count);
    });
    return FakeWorker.instances[index]!;
}

describe('MaiaOpponentClient worker protocol', () => {
    beforeEach(() => {
        FakeWorker.instances = [];
        vi.stubGlobal('Worker', FakeWorker);
        const runtimeEntries = new Map<string, Response>();
        vi.stubGlobal('caches', {
            delete: vi.fn().mockImplementation(async () => {
                runtimeEntries.clear();
                return true;
            }),
            open: vi.fn().mockResolvedValue({
                match: vi.fn().mockImplementation(
                    async (key: string) =>
                        runtimeEntries.get(String(key))?.clone()
                ),
                put: vi.fn().mockImplementation(
                    async (key: string, response: Response) => {
                        runtimeEntries.set(
                            String(key),
                            response.clone()
                        );
                    }
                ),
            }),
        });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(
                async () =>
                    new Response(
                        'self.onmessage = () => undefined',
                        {
                            status: 200,
                            headers: {
                                'Content-Type':
                                    'text/javascript',
                            },
                        }
                    )
            )
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('is lazy and forwards initialization progress', async () => {
        const client = new MaiaOpponentClient();
        const progress = vi.fn();

        expect(FakeWorker.instances).toHaveLength(0);
        expect(client.getStatus().phase).toBe('idle');

        const initializing = client.initialize({
            allowDownload: true,
            onProgress: progress,
        });
        const worker = await workerWithMessages();
        expect(worker.url).toMatch(/^blob:/);
        const request = worker.messages[0]!;
        expect(request.type).toBe('initialize');
        if (request.type !== 'initialize') {
            throw new Error('Expected an initialization request.');
        }
        expect(request.allowDownload).toBe(true);

        worker.emit({
            type: 'status',
            requestId: request.id,
            status: {
                phase: 'downloading',
                progress: 0.5,
                source: 'network',
                message: 'Downloading.',
            },
        });
        worker.emit({
            type: 'initialized',
            id: request.id,
            status: readyStatus,
        });

        await expect(initializing).resolves.toEqual(readyStatus);
        expect(progress).toHaveBeenCalledWith(
            expect.objectContaining({
                phase: 'downloading',
                progress: 0.5,
            })
        );
        expect(client.getStatus()).toEqual(readyStatus);
    });

    it('sends a preprocessed legal mask and resolves the versioned result', async () => {
        const client = new MaiaOpponentClient();
        const initializing = client.initialize({ allowDownload: true });
        const worker = await workerWithMessages();
        const init = worker.messages[0]!;
        worker.emit({
            type: 'initialized',
            id: init.id,
            status: readyStatus,
        });
        await initializing;

        const movePromise = client.selectMove({
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            selfElo: 1_600,
            opponentElo: 1_700,
            seed: 42,
        });
        const request = worker.messages[1]!;
        expect(request.type).toBe('select-move');
        if (request.type !== 'select-move') {
            throw new Error('Expected a move request.');
        }
        expect(request.tokens).toBeInstanceOf(Float32Array);
        expect(request.tokens).toHaveLength(64 * 12);
        expect(request.legalMoves).toHaveLength(20);
        expect(request.legalMoves.map((move) => move.moveUci)).toContain(
            'e2e4'
        );

        const result = {
            moveUci: 'e2e4',
            probability: 0.32,
            candidateCount: 10,
            modelId: MAIA_MODEL.id,
            modelVersion: MAIA_MODEL.version,
            engineRevision: MAIA_MODEL.engineRevision,
            samplerVersion: MAIA_MODEL.samplerVersion,
            seed: 42,
        };
        worker.emit({
            type: 'move',
            id: request.id,
            result,
        });

        await expect(movePromise).resolves.toEqual(result);
    });

    it('never falls back when the model is unavailable offline', async () => {
        const client = new MaiaOpponentClient();
        const initializing = client.initialize({ allowDownload: true });
        const worker = await workerWithMessages();
        const request = worker.messages[0]!;
        expect(request).toMatchObject({
            type: 'initialize',
            allowDownload: true,
        });
        worker.emit({
            type: 'error',
            id: request.id,
            error: {
                code: 'MODEL_UNAVAILABLE_OFFLINE',
                message: 'Maia is not downloaded yet.',
                recoverable: true,
            },
            status: {
                phase: 'error',
                progress: null,
                source: 'network',
                message: 'Maia is not downloaded yet.',
                errorCode: 'MODEL_UNAVAILABLE_OFFLINE',
            },
        });

        await expect(initializing).rejects.toMatchObject({
            code: 'MODEL_UNAVAILABLE_OFFLINE',
        });
        await expect(
            client.selectMove({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                selfElo: 1_600,
                opponentElo: 1_600,
                seed: 1,
            })
        ).rejects.toMatchObject({
            code: 'NOT_READY',
        });
        expect(worker.messages).toHaveLength(1);
    });

    it('boots local-only initialization from the cached worker blob', async () => {
        vi.stubGlobal('caches', {
            open: vi.fn().mockResolvedValue({
                match: vi.fn().mockResolvedValue(
                    new Response('self.onmessage = () => undefined', {
                        headers: {
                            'Content-Type': 'text/javascript',
                        },
                    })
                ),
            }),
        });
        const client = new MaiaOpponentClient();
        const initializing = client.initialize();

        await vi.waitFor(() =>
            expect(FakeWorker.instances).toHaveLength(1)
        );
        const worker = await workerWithMessages();
        expect(worker.url).toMatch(/^blob:/);
        await vi.waitFor(() =>
            expect(worker.messages).toHaveLength(1)
        );
        const request = worker.messages[0]!;
        expect(request).toMatchObject({
            type: 'initialize',
            allowDownload: false,
        });
        worker.emit({
            type: 'initialized',
            id: request.id,
            status: {
                ...readyStatus,
                source: 'cache',
            },
        });

        await expect(initializing).resolves.toMatchObject({
            phase: 'ready',
            source: 'cache',
        });
        client.terminate();
    });

    it('never coalesces local-only initialization into an active download', async () => {
        const client = new MaiaOpponentClient();
        const downloading = client.initialize({
            allowDownload: true,
        });
        const worker = await workerWithMessages();
        const request = worker.messages[0]!;

        await expect(client.initialize()).rejects.toMatchObject({
            code: 'BAD_REQUEST',
        });

        worker.emit({
            type: 'initialized',
            id: request.id,
            status: readyStatus,
        });
        await expect(downloading).resolves.toEqual(readyStatus);
    });

    it('never widens an active local-only initialization to download', async () => {
        let releaseCachedWorker!: (response: Response) => void;
        const cachedWorker = new Promise<Response>((resolve) => {
            releaseCachedWorker = resolve;
        });
        vi.stubGlobal('caches', {
            open: vi.fn().mockResolvedValue({
                match: vi.fn().mockReturnValue(cachedWorker),
            }),
        });
        const client = new MaiaOpponentClient();
        const localOnly = client.initialize();

        await expect(
            client.initialize({ allowDownload: true })
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
        });

        releaseCachedWorker(
            new Response('self.onmessage = () => undefined', {
                headers: { 'Content-Type': 'text/javascript' },
            })
        );
        await vi.waitFor(() =>
            expect(FakeWorker.instances).toHaveLength(1)
        );
        const worker = FakeWorker.instances[0]!;
        await vi.waitFor(() =>
            expect(worker.messages).toHaveLength(1)
        );
        const request = worker.messages[0]!;
        worker.emit({
            type: 'initialized',
            id: request.id,
            status: {
                ...readyStatus,
                source: 'cache',
            },
        });
        await expect(localOnly).resolves.toMatchObject({
            source: 'cache',
        });
        client.terminate();
    });

    it('surfaces a synchronous Worker constructor failure as recoverable error state', async () => {
        vi.stubGlobal(
            'Worker',
            class {
                constructor() {
                    throw new Error('Worker blocked by policy');
                }
            }
        );
        const client = new MaiaOpponentClient();

        await expect(
            client.initialize({ allowDownload: true })
        ).rejects.toMatchObject({
            code: 'WORKER_ERROR',
        });
        expect(client.getStatus()).toMatchObject({
            phase: 'error',
            errorCode: 'WORKER_ERROR',
        });
    });

    it('rejects pending work and cannot restart after terminate', async () => {
        const client = new MaiaOpponentClient();
        const initializing = client.initialize({ allowDownload: true });

        client.terminate();

        await expect(initializing).rejects.toBeInstanceOf(MaiaOpponentError);
        expect(client.getStatus().phase).toBe('terminated');
        await expect(
            client.initialize({ allowDownload: true })
        ).rejects.toMatchObject({
            code: 'TERMINATED',
        });
        expect(FakeWorker.instances).toHaveLength(0);
    });

    it('waits for worker preparation before offline data can be removed', async () => {
        let releaseWorkerDownload!: (response: Response) => void;
        const workerDownload = new Promise<Response>((resolve) => {
            releaseWorkerDownload = resolve;
        });
        const put = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(workerDownload));
        vi.stubGlobal('caches', {
            delete: vi.fn().mockResolvedValue(true),
            open: vi.fn().mockResolvedValue({
                put,
            }),
        });
        const client = new MaiaOpponentClient();
        const initializing = client
            .initialize({ allowDownload: true })
            .catch((error) => error);

        const terminated = client.terminateAndWait();
        releaseWorkerDownload(
            new Response('self.onmessage = () => undefined', {
                status: 200,
                headers: { 'Content-Type': 'text/javascript' },
            })
        );

        await terminated;
        await expect(initializing).resolves.toMatchObject({
            code: 'TERMINATED',
        });
        expect(put).not.toHaveBeenCalled();
        expect(FakeWorker.instances).toHaveLength(0);
    });

    it('cannot create a worker after termination during cached blob loading', async () => {
        let releaseBlob!: (blob: Blob) => void;
        const blob = vi.fn().mockReturnValue(
            new Promise<Blob>((resolve) => {
                releaseBlob = resolve;
            })
        );
        vi.stubGlobal('caches', {
            open: vi.fn().mockResolvedValue({
                match: vi.fn().mockResolvedValue({
                    blob,
                }),
            }),
        });
        const client = new MaiaOpponentClient();
        const initializing = client.initialize().catch((error) => error);
        await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce());

        const terminated = client.terminateAndWait();
        releaseBlob(
            new Blob(['self.onmessage = () => undefined'], {
                type: 'text/javascript',
            })
        );

        await terminated;
        await expect(initializing).resolves.toMatchObject({
            code: 'TERMINATED',
        });
        expect(FakeWorker.instances).toHaveLength(0);
        expect(client.getStatus().phase).toBe('terminated');
    });

    it('turns an initialization timeout into a retryable fresh worker', async () => {
        vi.useFakeTimers();
        const client = new MaiaOpponentClient();
        const initializing = client.initialize({ allowDownload: true });
        const timeoutError = initializing.catch((error) => error);
        const firstWorker = await workerWithMessages();

        await vi.advanceTimersByTimeAsync(180_000);

        await expect(timeoutError).resolves.toMatchObject({
            code: 'TIMEOUT',
        });
        expect(client.getStatus()).toMatchObject({
            phase: 'error',
            errorCode: 'TIMEOUT',
        });
        expect(firstWorker.terminated).toBe(true);

        const retry = client.initialize({ allowDownload: true });
        const retryWorker = await workerWithMessages(1);
        const retryRequest = retryWorker.messages[0]!;
        retryWorker.emit({
            type: 'initialized',
            id: retryRequest.id,
            status: readyStatus,
        });

        await expect(retry).resolves.toEqual(readyStatus);
    });

    it('terminates a timed-out inference and can initialize again', async () => {
        vi.useFakeTimers();
        const client = new MaiaOpponentClient();
        const initializing = client.initialize({ allowDownload: true });
        const firstWorker = await workerWithMessages();
        const init = firstWorker.messages[0]!;
        firstWorker.emit({
            type: 'initialized',
            id: init.id,
            status: readyStatus,
        });
        await initializing;

        const move = client.selectMove({
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            selfElo: 1_600,
            opponentElo: 1_600,
            seed: 7,
        });
        const timeoutError = move.catch((error) => error);
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(timeoutError).resolves.toMatchObject({
            code: 'TIMEOUT',
        });
        expect(client.getStatus()).toMatchObject({
            phase: 'error',
            errorCode: 'TIMEOUT',
        });
        expect(firstWorker.terminated).toBe(true);
        expect(FakeWorker.instances).toHaveLength(1);

        void client.initialize({ allowDownload: true });
        await workerWithMessages(1);
        expect(FakeWorker.instances).toHaveLength(2);
    });
});
