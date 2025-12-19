import { inspect } from 'node:util';
import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { authConfig } from './config';

const authDebug = process.env.NEXTAUTH_DEBUG === 'true';

function formatAuthLogArgs(args: unknown[]) {
    return args.map((arg) =>
        typeof arg === 'string'
            ? arg
            : inspect(arg, { depth: authDebug ? 10 : 2, colors: false })
    );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
    adapter: PrismaAdapter(prisma),
    secret: process.env.NEXTAUTH_SECRET,
    // Required behind proxies/CDNs (e.g. Vercel) so Auth.js can trust forwarded
    // host/proto headers when deriving callback URLs and setting cookies.
    trustHost: true,
    // Enable verbose server logs when diagnosing production auth issues.
    debug: authDebug,
    logger: {
        error(code, ...message) {
            console.error('[auth][error]', code, ...formatAuthLogArgs(message));
        },
        warn(code, ...message) {
            console.warn('[auth][warn]', code, ...formatAuthLogArgs(message));
        },
        debug(code, ...message) {
            // Only emit debug logs when explicitly enabled.
            if (authDebug) {
                console.debug(
                    '[auth][debug]',
                    code,
                    ...formatAuthLogArgs(message)
                );
            }
        },
    },
    session: { strategy: 'database' },
    callbacks: {
        session({ session, user }) {
            if (session.user) {
                session.user.id = user.id;
            }
            return session;
        },
    },
    ...authConfig,
});
