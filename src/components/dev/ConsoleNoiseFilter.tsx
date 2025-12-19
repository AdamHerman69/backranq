'use client';

import { useEffect } from 'react';

function textFromArgs(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a && typeof a === 'object' && 'message' in (a as any)) {
                const m = (a as any).message;
                return typeof m === 'string' ? m : '';
            }
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
}

export function ConsoleNoiseFilter() {
    useEffect(() => {
        if (process.env.NODE_ENV === 'production') return;

        const ignore = [
            // Next dev warnings triggered by React DevTools inspecting props
            /params are being enumerated/i,
            /The keys of `searchParams` were accessed directly/i,
            /`params` is a Promise and must be unwrapped/i,
            /`searchParams` is a Promise and must be unwrapped/i,
        ];

        const origError = console.error;
        const origWarn = console.warn;

        function shouldIgnore(args: unknown[]) {
            const t = textFromArgs(args);
            return ignore.some((re) => re.test(t));
        }

        console.error = (...args: unknown[]) => {
            if (shouldIgnore(args)) return;
            origError(...args);
        };
        console.warn = (...args: unknown[]) => {
            if (shouldIgnore(args)) return;
            origWarn(...args);
        };

        return () => {
            console.error = origError;
            console.warn = origWarn;
        };
    }, []);

    return null;
}



