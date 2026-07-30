'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
    clearMaiaOfflineData,
    inspectMaiaOfflineData,
    MaiaOpponentClient,
    UNKNOWN_MAIA_INSTALL_STATUS,
    type MaiaEngineStatus,
    type MaiaMoveRequest,
    type MaiaMoveResult,
} from '@/lib/coach/maia';

const INITIAL_STATUS: MaiaEngineStatus = {
    phase: 'idle',
    progress: null,
    source: null,
    message: 'Maia has not been loaded yet.',
};

export function useMaiaOpponent() {
    const [status, setStatus] =
        useState<MaiaEngineStatus>(INITIAL_STATUS);
    const [installStatus, setInstallStatus] = useState(
        UNKNOWN_MAIA_INSTALL_STATUS
    );
    const clientRef = useRef<MaiaOpponentClient | null>(null);
    const initializeRef = useRef<{
        allowDownload: boolean;
        promise: Promise<boolean>;
        token: object;
    } | null>(null);
    const mountedRef = useRef(true);

    const ensure = useCallback(() => {
        if (clientRef.current) return clientRef.current;
        const next = new MaiaOpponentClient();
        clientRef.current = next;
        return next;
    }, []);

    const initialize = useCallback(async (
        allowDownload = false
    ): Promise<boolean> => {
        if (initializeRef.current) {
            return initializeRef.current.allowDownload ===
                allowDownload
                ? initializeRef.current.promise
                : false;
        }
        const current = ensure();
        const token = {};
        const operation = (async () => {
            try {
                const ready = await current.initialize({
                    allowDownload,
                    onProgress: (nextStatus) => {
                        if (
                            mountedRef.current &&
                            clientRef.current === current
                        ) {
                            setStatus(nextStatus);
                        }
                    },
                });
                if (
                    mountedRef.current &&
                    clientRef.current === current
                ) {
                    setStatus(ready);
                    const stored = await inspectMaiaOfflineData();
                    if (
                        mountedRef.current &&
                        clientRef.current === current
                    ) {
                        setInstallStatus(stored);
                    }
                }
                return ready.phase === 'ready';
            } catch {
                const failed = current.getStatus();
                const stored = await inspectMaiaOfflineData();
                if (
                    mountedRef.current &&
                    clientRef.current === current
                ) {
                    setStatus(failed);
                    setInstallStatus(stored);
                }
                return false;
            } finally {
                if (
                    initializeRef.current?.token === token
                ) {
                    initializeRef.current = null;
                }
            }
        })();
        initializeRef.current = {
            allowDownload,
            promise: operation,
            token,
        };
        return operation;
    }, [ensure]);

    const selectMove = useCallback(
        async (request: MaiaMoveRequest): Promise<MaiaMoveResult> => {
            const current = clientRef.current;
            if (!current || current.getStatus().phase !== 'ready') {
                throw new Error(
                    'The Maia opponent is not ready. Retry the local model download.'
                );
            }
            try {
                return await current.selectMove(request);
            } catch (error) {
                if (
                    mountedRef.current &&
                    clientRef.current === current
                ) {
                    setStatus(current.getStatus());
                }
                throw error;
            }
        },
        []
    );

    const reset = useCallback(() => {
        initializeRef.current = null;
        clientRef.current?.terminate();
        clientRef.current = null;
        setStatus(INITIAL_STATUS);
    }, []);

    const removeOfflineData = useCallback(async (): Promise<
        string | null
    > => {
        const current = clientRef.current;
        initializeRef.current = null;
        current?.terminate();
        clientRef.current = null;
        try {
            await current?.terminateAndWait();
            await clearMaiaOfflineData();
            if (mountedRef.current) {
                setStatus(INITIAL_STATUS);
                setInstallStatus({
                    ...UNKNOWN_MAIA_INSTALL_STATUS,
                    checking: false,
                });
            }
            return null;
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'Could not remove the saved Maia opponent.';
            if (mountedRef.current) {
                setStatus({
                    phase: 'error',
                    progress: null,
                    source: null,
                    message,
                    errorCode: 'CACHE_ERROR',
                });
                setInstallStatus(await inspectMaiaOfflineData());
            }
            return message;
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void inspectMaiaOfflineData().then((stored) => {
            if (mountedRef.current) setInstallStatus(stored);
        });
        return () => {
            mountedRef.current = false;
            clientRef.current?.terminate();
            clientRef.current = null;
        };
    }, []);

    return {
        status,
        installStatus,
        initialize,
        selectMove,
        reset,
        removeOfflineData,
    };
}
