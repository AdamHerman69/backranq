export const DEFAULT_AUTH_CALLBACK_URL = '/home';

const CALLBACK_BASE_URL = 'https://backranq.invalid';
const UNSAFE_CALLBACK_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const MAX_DECODE_PASSES = 4;

function isSafeRelativeCallback(value: string): boolean {
    if (
        value.length === 0 ||
        value !== value.trim() ||
        !value.startsWith('/') ||
        value.startsWith('//')
    ) {
        return false;
    }

    let decoded = value;
    for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
        if (
            UNSAFE_CALLBACK_CHARACTERS.test(decoded) ||
            decoded.startsWith('//')
        ) {
            return false;
        }

        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) {
                return (
                    !UNSAFE_CALLBACK_CHARACTERS.test(decoded) &&
                    !decoded.startsWith('//')
                );
            }
            decoded = next;
        } catch {
            return false;
        }
    }

    // Deeply nested encoding is never required for an app-owned callback.
    return false;
}

function canonicalRelativeCallback(value: string): string | null {
    if (!isSafeRelativeCallback(value)) return null;

    try {
        const url = new URL(value, CALLBACK_BASE_URL);
        if (url.origin !== CALLBACK_BASE_URL) return null;
        const canonical = `${url.pathname}${url.search}${url.hash}`;
        return isSafeRelativeCallback(canonical) ? canonical : null;
    } catch {
        return null;
    }
}

export function safeAuthCallbackUrl(
    value: unknown,
    fallback = DEFAULT_AUTH_CALLBACK_URL
): string {
    const safeFallback =
        canonicalRelativeCallback(fallback) ?? DEFAULT_AUTH_CALLBACK_URL;

    if (typeof value !== 'string') return safeFallback;
    return canonicalRelativeCallback(value) ?? safeFallback;
}
