import type { NextAuthConfig } from 'next-auth';
import Discord from 'next-auth/providers/discord';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';

export type OAuthProviderId = 'google' | 'github' | 'discord';

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
                  }),
              ]
            : []),
        ...(isEnabled('github')
            ? [
                  GitHub({
                      clientId: process.env.GITHUB_ID!,
                      clientSecret: process.env.GITHUB_SECRET!,
                  }),
              ]
            : []),
        ...(isEnabled('discord')
            ? [
                  Discord({
                      clientId: process.env.DISCORD_CLIENT_ID!,
                      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
                  }),
              ]
            : []),
    ],
} satisfies NextAuthConfig;
