const SENSITIVE_AUTH_VALUE =
    /(authorization|cookie|set-cookie|access_token|refresh_token|id_token|code_verifier|client_secret|token|secret)(\s*[:=]\s*)([^\s,;]+)/gi;
const AUTH_SCHEME_VALUE = /\b(bearer|basic)\s+[^\s,;]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function authDebugEnabled(
    env: Partial<
        Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'NEXTAUTH_DEBUG'>
    > = process.env
) {
    return env.NODE_ENV !== 'production' && env.NEXTAUTH_DEBUG === 'true';
}

export function createSafeAuthLogger(debugEnabled: boolean) {
    return {
        error(code: unknown, ...message: unknown[]) {
            const error =
                code instanceof Error
                    ? code
                    : message.find(
                          (value): value is Error => value instanceof Error
                      );
            console.error(
                '[auth][error]',
                error ? safeErrorChain(error) : safeEventCode(code)
            );
        },
        warn(code: unknown, ...message: unknown[]) {
            void message;
            console.warn('[auth][warn]', safeEventCode(code));
        },
        debug(code: unknown, ...message: unknown[]) {
            void message;
            if (!debugEnabled) return;
            // Auth.js debug metadata can contain Request, headers, cookies and
            // OAuth material. The stable event code is enough to correlate the
            // surrounding request without serializing that metadata.
            console.debug('[auth][debug]', safeEventCode(code));
        },
    };
}

function safeErrorChain(error: Error, depth = 0): string {
    if (depth > 5) return '[cause depth exceeded]';
    // Error messages routinely contain callback URLs and OAuth parameters.
    // Only the stable error class is safe to emit; metadata belongs in an
    // explicitly redacted, request-scoped diagnostic path instead.
    const summary = safeEventCode(error.name || 'Error');
    const cause = (error as Error & { cause?: unknown }).cause;
    if (!(cause instanceof Error)) return summary;
    return `${summary}\n  [cause]: ${safeErrorChain(cause, depth + 1)}`;
}

function safeEventCode(code: unknown) {
    return typeof code === 'string'
        ? redactAuthText(code).slice(0, 256)
        : '[auth event details omitted]';
}

function redactAuthText(value: string) {
    return value
        .replace(AUTH_SCHEME_VALUE, '$1 [redacted]')
        .replace(SENSITIVE_AUTH_VALUE, '$1$2[redacted]')
        .replace(JWT_VALUE, '[redacted-jwt]')
        .slice(0, 1_000);
}
