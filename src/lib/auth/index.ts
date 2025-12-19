import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { authConfig } from './config';

export const { handlers, auth, signIn, signOut } = NextAuth({
    adapter: PrismaAdapter(prisma),
    secret: process.env.NEXTAUTH_SECRET,
    // Required behind proxies/CDNs (e.g. Vercel) so Auth.js can trust forwarded
    // host/proto headers when deriving callback URLs and setting cookies.
    trustHost: true,
    // Enable verbose server logs when diagnosing production auth issues.
    debug: process.env.NEXTAUTH_DEBUG === 'true',
    logger: {
        error(code, ...message) {
            console.error('[auth][error]', code, ...message);
        },
        warn(code, ...message) {
            console.warn('[auth][warn]', code, ...message);
        },
        debug(code, ...message) {
            // Only emit debug logs when explicitly enabled.
            if (process.env.NEXTAUTH_DEBUG === 'true') {
                console.debug('[auth][debug]', code, ...message);
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
