import type { OAuthConfig } from 'next-auth/providers';

type LichessAccount = {
    id: string;
    username: string;
    // Other fields exist; we only rely on id/username.
};

type LichessEmail = {
    email?: string;
};

type LichessProfile = Partial<LichessAccount> & {
    email?: string | null;
    // fallback identifier when account endpoint isn't accessible
    fallbackId?: string;
};

export default function LichessProvider(options: {
    clientId: string;
    clientSecret?: string;
    allowDangerousEmailAccountLinking?: boolean;
}): OAuthConfig<LichessProfile> {
    return {
        id: 'lichess',
        name: 'Lichess',
        type: 'oauth',
        clientId: options.clientId,
        // Lichess supports PKCE; client secret may be optional depending on app type.
        clientSecret: options.clientSecret,
        authorization: {
            url: 'https://lichess.org/oauth',
            params: {
                // Based on the official oauth-app example, email requires email:read.
                // See: https://github.com/lichess-org/api/tree/master/example/oauth-app
                scope: 'email:read',
            },
        },
        token: {
            url: 'https://lichess.org/api/token',
            // Lichess expects client_id in the POST body, not via Basic auth header.
            // Setting conformOptions below handles this for public PKCE clients.
        },
        // Lichess is a public PKCE client (no client_secret), so we must tell Auth.js
        // to send client_id in the body rather than using client_secret_basic.
        client: {
            token_endpoint_auth_method: 'none',
        },
        checks: ['pkce', 'state'],
        allowDangerousEmailAccountLinking:
            options.allowDangerousEmailAccountLinking,
        userinfo: {
            // Auth.js validates that at least one of `issuer` or a `userinfo` endpoint
            // (string or object with `url`) is configured.
            url: 'https://lichess.org/api/account',
            async request({
                tokens,
            }: {
                tokens: { access_token?: string | null };
            }) {
                const accessToken = tokens.access_token;
                if (!accessToken)
                    throw new Error('Missing Lichess access token');

                // The official oauth-app example only requires `email:read` and calls
                // /api/account/email. Some endpoints may require additional scopes, so
                // we treat /api/account as best-effort.
                const [accountRes, emailRes] = await Promise.all([
                    fetch('https://lichess.org/api/account', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }).catch(() => null),
                    fetch('https://lichess.org/api/account/email', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }).catch(() => null),
                ]);

                const account: LichessAccount | null =
                    accountRes && accountRes.ok
                        ? ((await accountRes.json()) as LichessAccount)
                        : null;

                let email: string | null = null;
                if (emailRes && emailRes.ok) {
                    const emailJson = (await emailRes.json()) as LichessEmail;
                    email = emailJson.email ?? null;
                }

                if (!account && !email) {
                    const a = accountRes ? `${accountRes.status}` : 'network';
                    const e = emailRes ? `${emailRes.status}` : 'network';
                    throw new Error(
                        `Lichess userinfo fetch failed (account=${a}, email=${e})`
                    );
                }

                return account
                    ? { ...account, email }
                    : { email, fallbackId: email ?? undefined };
            },
        },
        profile(profile) {
            const id = profile.id ?? profile.fallbackId ?? 'unknown';
            const name = profile.username ?? profile.email ?? 'Lichess user';
            return {
                id,
                name,
                email: profile.email ?? null,
                image: null,
            };
        },
    };
}
