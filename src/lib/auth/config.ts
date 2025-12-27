import type { NextAuthConfig } from 'next-auth';
import Discord from 'next-auth/providers/discord';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Apple from 'next-auth/providers/apple';
import Lichess from '@/lib/auth/providers/lichess';

export type OAuthProviderId = 'google' | 'github' | 'discord' | 'apple' | 'lichess';

const allowDangerousEmailAccountLinking =
    process.env.AUTH_DANGEROUS_EMAIL_LINKING === 'true';

function getLichessClientId(): string | null {
    if (process.env.LICHESS_CLIENT_ID) return process.env.LICHESS_CLIENT_ID;
    // Lichess OAuth can work without app registration; we just need a stable string.
    // Default to the NEXTAUTH_URL hostname when present.
    try {
        const url = process.env.NEXTAUTH_URL
            ? new URL(process.env.NEXTAUTH_URL)
            : null;
        return url?.hostname ?? null;
    } catch {
        return null;
    }
}

export const AUTH_PROVIDER_UI: Array<{
    id: OAuthProviderId;
    label: string;
    enabled: boolean;
}> = [
    {
        id: 'google',
        label: 'Google',
        enabled: Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ),
    },
    {
        id: 'github',
        label: 'GitHub',
        enabled: Boolean(process.env.GITHUB_ID && process.env.GITHUB_SECRET),
    },
    {
        id: 'discord',
        label: 'Discord',
        enabled: Boolean(
            process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
        ),
    },
    {
        id: 'apple',
        label: 'Apple',
        enabled: Boolean(
            process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
        ),
    },
    {
        id: 'lichess',
        label: 'Lichess',
        enabled:
            process.env.LICHESS_ENABLED === 'true' ||
            Boolean(process.env.LICHESS_CLIENT_ID),
    },
];

function isEnabled(id: OAuthProviderId) {
    return AUTH_PROVIDER_UI.find((p) => p.id === id)?.enabled ?? false;
}

export const authConfig = {
    pages: {
        signIn: '/login',
    },
    providers: [
        ...(isEnabled('google')
            ? [
                  Google({
                      clientId: process.env.GOOGLE_CLIENT_ID!,
                      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
                      allowDangerousEmailAccountLinking,
                  }),
              ]
            : []),
        ...(isEnabled('github')
            ? [
                  GitHub({
                      clientId: process.env.GITHUB_ID!,
                      clientSecret: process.env.GITHUB_SECRET!,
                      allowDangerousEmailAccountLinking,
                  }),
              ]
            : []),
        ...(isEnabled('discord')
            ? [
                  Discord({
                      clientId: process.env.DISCORD_CLIENT_ID!,
                      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
                      allowDangerousEmailAccountLinking,
                  }),
              ]
            : []),
        ...(isEnabled('apple')
            ? [
                  Apple({
                      clientId: process.env.APPLE_CLIENT_ID!,
                      clientSecret: process.env.APPLE_CLIENT_SECRET!,
                      allowDangerousEmailAccountLinking,
                  }),
              ]
            : []),
        ...(isEnabled('lichess')
            ? [
                  Lichess({
                      clientId: getLichessClientId() ?? 'localhost',
                      clientSecret: process.env.LICHESS_CLIENT_SECRET,
                      allowDangerousEmailAccountLinking,
                  }),
              ]
            : []),
    ],
} satisfies NextAuthConfig;
