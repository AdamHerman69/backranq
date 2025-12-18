import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    MultiPvStreamingUpdate,
    StockfishClient,
    StreamingAnalysisHandle,
} from '@/lib/analysis/stockfishClient';

export function useStockfishLiveMultiPvAnalysis(opts: {
    client: StockfishClient | null;
    fen: string | null;
    multiPv: number; // 1..5
    enabled: boolean;
    minDepth?: number;
    maxDepth?: number;
    maxTimeMs?: number;
    emitIntervalMs?: number;
}) {
    const handleRef = useRef<StreamingAnalysisHandle | null>(null);
    const runIdRef = useRef(0);

    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [update, setUpdate] = useState<MultiPvStreamingUpdate | null>(null);

    const stopExternal = useCallback(() => {
        runIdRef.current++;
        handleRef.current?.stop();
        handleRef.current = null;
    }, []);

    const startExternal = useCallback(() => {
        const client = opts.client;
        const fen = opts.fen;
        if (!client || !fen) return;

        stopExternal();
        const runId = ++runIdRef.current;

        handleRef.current = client.startAnalyzeMultiPvStreaming({
            fen,
            multiPv: opts.multiPv,
            minDepth: opts.minDepth,
            maxDepth: opts.maxDepth,
            maxTimeMs: opts.maxTimeMs,
            emitIntervalMs: opts.emitIntervalMs,
            onUpdate: (u) => {
                if (runIdRef.current !== runId) return;
                setUpdate(u);
                setRunning(true);
            },
            onError: (e) => {
                if (runIdRef.current !== runId) return;
                setError(e.message);
                setRunning(false);
            },
            onDone: () => {
                if (runIdRef.current !== runId) return;
                setRunning(false);
            },
        });
    }, [
        opts.client,
        opts.emitIntervalMs,
        opts.fen,
        opts.maxDepth,
        opts.maxTimeMs,
        opts.minDepth,
        opts.multiPv,
        stopExternal,
    ]);

    const stop = useCallback(() => {
        stopExternal();
        setRunning(false);
    }, [stopExternal]);

    const start = useCallback(() => {
        if (!opts.client || !opts.fen) return;
        setError(null);
        setRunning(true);
        startExternal();
    }, [opts.client, opts.fen, startExternal]);

    useEffect(() => {
        if (!opts.enabled || !opts.client || !opts.fen) {
            stopExternal();
            return;
        }
        startExternal();
        return () => stopExternal();
    }, [
        opts.client,
        opts.enabled,
        opts.fen,
        opts.multiPv,
        startExternal,
        stopExternal,
    ]);

    return {
        running: opts.enabled ? running : false,
        error: opts.enabled ? error : null,
        update,
        lines: update?.lines ?? [],
        depth: update?.depth,
        timeMs: update?.timeMs,
        start,
        stop,
    };
}

