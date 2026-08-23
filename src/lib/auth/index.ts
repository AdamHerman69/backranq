import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { authConfig } from './config';
import { syncVerifiedLichessIdentity } from './lichessIdentity';
import { authDebugEnabled, createSafeAuthLogger } from './logging';

const authDebug = authDebugEnabled();

export const { handlers, auth, signIn, signOut } = NextAuth({
    adapter: PrismaAdapter(prisma),
    secret: process.env.NEXTAUTH_SECRET,
    // Required behind proxies/CDNs (e.g. Vercel) so Auth.js can trust forwarded
    // host/proto headers when deriving callback URLs and setting cookies.
    trustHost: true,
    // Verbose Auth.js diagnostics are restricted to explicit local/preview use.
    debug: authDebug,
    logger: createSafeAuthLogger(authDebug),
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
    events: {
        async signIn(event) {
            await syncVerifiedLichessIdentity(event);
        },
        async createUser({ user }) {
            if (!user.id) return;
            const { recordWelcome } = await import('@/lib/notifications/service');
            const { dispatchPendingNotificationDeliveries } = await import(
                '@/lib/notifications/delivery'
            );
            await recordWelcome(user.id).catch((error) => {
                console.error('[notifications] welcome event was not recorded', error);
            });
            await dispatchPendingNotificationDeliveries().catch((error) => {
                console.error('[notifications] delivery wakeup failed', error);
            });
        },
    },
});
