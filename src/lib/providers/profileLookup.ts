export type ProfileProvider = 'lichess' | 'chesscom';

export type ProviderProfileLookup =
    | { state: 'found' }
    | { state: 'not-found' }
    | {
          state: 'source-error';
          error: string;
          httpStatus: 429 | 502 | 503 | 504;
          sourceStatus: number | null;
      };

export const PROVIDER_PROFILE_TIMEOUT_MS = 8_000;

export function providerProfileLabel(provider: ProfileProvider) {
    return provider === 'lichess' ? 'Lichess' : 'Chess.com';
}

export async function lookupProviderProfile(args: {
    provider: ProfileProvider;
    username: string;
}): Promise<ProviderProfileLookup> {
    const username = args.username.trim();
    if (!username) return { state: 'found' };

    const label = providerProfileLabel(args.provider);
    const endpoint =
        args.provider === 'lichess'
            ? `https://lichess.org/api/user/${encodeURIComponent(username)}`
            : `https://api.chess.com/pub/player/${encodeURIComponent(
                  username.toLowerCase()
              )}`;

    try {
        const response = await fetch(endpoint, {
            cache: 'no-store',
            signal: AbortSignal.timeout(PROVIDER_PROFILE_TIMEOUT_MS),
        });
        if (response.ok) return { state: 'found' };
        if (response.status === 404) return { state: 'not-found' };
        if (response.status === 429) {
            return {
                state: 'source-error',
                error: `${label} is rate limiting profile checks. Try again shortly.`,
                httpStatus: 429,
                sourceStatus: response.status,
            };
        }
        if (response.status >= 500) {
            return {
                state: 'source-error',
                error: `${label} profile validation is temporarily unavailable (source status ${response.status}). Try again.`,
                httpStatus: 503,
                sourceStatus: response.status,
            };
        }
        return {
            state: 'source-error',
            error: `${label} could not verify this username right now (source status ${response.status}). Try again.`,
            httpStatus: 502,
            sourceStatus: response.status,
        };
    } catch (error) {
        const timedOut =
            error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError');
        return {
            state: 'source-error',
            error: timedOut
                ? `${label} profile validation timed out. Try again.`
                : `${label} profile validation is temporarily unavailable. Try again.`,
            httpStatus: timedOut ? 504 : 502,
            sourceStatus: null,
        };
    }
}
