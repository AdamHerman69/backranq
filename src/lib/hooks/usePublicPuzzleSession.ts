'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { TrainingPromptDto } from '@/lib/training/api';
import { usePuzzleSession } from '@/lib/hooks/usePuzzleSession';

type NetworkConnection = {
    saveData?: boolean;
};

type NavigatorWithConnection = Navigator & {
    connection?: NetworkConnection;
};

type IdleWindow = Window & {
    requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
};

export function allowsPublicEnginePrewarm(
    connection: NetworkConnection | null | undefined
): boolean {
    return connection?.saveData !== true;
}

function scheduleIdlePrewarm(callback: () => void): () => void {
    const idleWindow = window as IdleWindow;
    if (idleWindow.requestIdleCallback) {
        const handle = idleWindow.requestIdleCallback(callback, {
            timeout: 1_500,
        });
        return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(callback, 250);
    return () => window.clearTimeout(handle);
}

/**
 * Anonymous onboarding adapter. All chess behavior lives in the shared puzzle
 * runtime; this wrapper only selects the public unresolved/engine policy.
 */
export function usePublicPuzzleSession(prompt: TrainingPromptDto) {
    const session = usePuzzleSession({
        initialPrompt: prompt,
        unresolvedMode: 'REVEAL',
        prewarmEngine: false,
        stopEngineOnTerminal: true,
    });
    const {
        engineClient,
        getOrCreateEngine,
        stopEngine,
        terminal,
    } = session;
    const cancelPrewarmRef = useRef<(() => void) | null>(null);
    const prewarmRequestedRef = useRef(false);

    const requestEnginePrewarm = useCallback(() => {
        if (prewarmRequestedRef.current || engineClient) return;
        const connection = (navigator as NavigatorWithConnection).connection;
        if (!allowsPublicEnginePrewarm(connection)) return;

        prewarmRequestedRef.current = true;
        cancelPrewarmRef.current = scheduleIdlePrewarm(() => {
            cancelPrewarmRef.current = null;
            try {
                const engine = getOrCreateEngine();
                void engine.getIdentity().catch(() => {
                    stopEngine();
                });
            } catch {
                // A submitted unknown move can retry engine creation directly.
            }
        });
    }, [engineClient, getOrCreateEngine, stopEngine]);

    useEffect(() => {
        if (!terminal) return;
        cancelPrewarmRef.current?.();
        cancelPrewarmRef.current = null;
    }, [terminal]);

    useEffect(
        () => () => {
            cancelPrewarmRef.current?.();
            cancelPrewarmRef.current = null;
        },
        []
    );

    return {
        ...session,
        requestEnginePrewarm,
    };
}
