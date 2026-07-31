'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
    StockfishClient,
    type MultiPvResult,
} from '@/lib/analysis/stockfishClient';
import type { CoachEngineWarmupStatus } from '@/lib/coach/types';

export function useCoachEngine() {
    const [client, setClient] = useState<StockfishClient | null>(null);
    const [status, setStatus] =
        useState<CoachEngineWarmupStatus>('idle');
    const clientRef = useRef<StockfishClient | null>(null);
    const searchAbortRef = useRef<AbortController | null>(null);
    const mountedRef = useRef(true);

    const ensure = useCallback(() => {
        if (clientRef.current) return clientRef.current;
        const next = new StockfishClient();
        clientRef.current = next;
        setClient(next);
        return next;
    }, []);

    const cancelSearch = useCallback(() => {
        searchAbortRef.current?.abort();
        searchAbortRef.current = null;
        clientRef.current?.cancelAll();
    }, []);

    const terminate = useCallback(
        (nextStatus: CoachEngineWarmupStatus = 'idle') => {
            searchAbortRef.current?.abort();
            searchAbortRef.current = null;
            clientRef.current?.terminate();
            clientRef.current = null;
            setClient(null);
            setStatus(nextStatus);
        },
        []
    );

    const prepare = useCallback(async (): Promise<boolean> => {
        if (!mountedRef.current) return false;
        setStatus('loading');
        try {
            const current = ensure();
            await Promise.all([
                current.getIdentity(),
                import(
                    '@/components/training/TrainingAnalysisWorkspace'
                ),
            ]);
            if (
                !mountedRef.current ||
                clientRef.current !== current
            ) {
                return false;
            }
            setStatus('ready');
            return true;
        } catch {
            if (!mountedRef.current) return false;
            terminate('error');
            return false;
        }
    }, [ensure, terminate]);

    const analyze = useCallback(
        async (args: {
            fen: string;
            nodes: number;
            multiPv: number;
            timeoutMs: number;
            rootMoves?: readonly string[];
        }): Promise<MultiPvResult> => {
            const current = ensure();
            searchAbortRef.current?.abort();
            const controller = new AbortController();
            searchAbortRef.current = controller;
            try {
                return await current.analyzeMultiPv({
                    fen: args.fen,
                    nodes: args.nodes,
                    multiPv: args.multiPv,
                    timeoutMs: args.timeoutMs,
                    rootMoves: args.rootMoves,
                    signal: controller.signal,
                });
            } finally {
                if (searchAbortRef.current === controller) {
                    searchAbortRef.current = null;
                }
            }
        },
        [ensure]
    );

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            searchAbortRef.current?.abort();
            clientRef.current?.terminate();
            clientRef.current = null;
        };
    }, []);

    return {
        client,
        status,
        ensure,
        prepare,
        analyze,
        cancelSearch,
        terminate,
    };
}
