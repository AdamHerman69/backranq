import { inspect } from 'node:util';
import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import { authConfig } from './config';

const authDebug = process.env.NEXTAUTH_DEBUG === 'true';

/**
 * Recursively extract error cause chain for logging.
 */
function extractErrorDetails(err: unknown, depth = 0): string {
    if (depth > 5) return '[max depth]';
    if (!(err instanceof Error)) {
        return inspect(err, { depth: 5, showHidden: true, colors: false });
    }
    const lines: string[] = [];
    lines.push(`${err.name}: ${err.message}`);
    // Auth.js stores cause on a symbol, but also as .cause in ES2022
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause) {
        lines.push(`  [cause]: ${extractErrorDetails(cause, depth + 1)}`);
    }
    // Also check for any extra properties
    for (const key of Object.keys(err)) {
        if (key !== 'name' && key !== 'message' && key !== 'stack') {
            lines.push(
                `  ${key}: ${inspect(
                    (err as unknown as Record<string, unknown>)[key],
                    { depth: 3, colors: false }
                )}`
            );
        }
    }
    return lines.join('\n');
}

function formatAuthLogArgs(
    args: unknown[],
    opts?: { depth?: number; showHidden?: boolean; expandErrors?: boolean }
) {
    const depth = opts?.depth ?? (authDebug ? 10 : 2);
    const showHidden = opts?.showHidden ?? false;
    const expandErrors = opts?.expandErrors ?? false;
    return args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (expandErrors && arg instanceof Error) {
            return extractErrorDetails(arg);
        }
        return inspect(arg, { depth, showHidden, colors: false });
    });
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
            // code is often the Error itself in Auth.js v5
            const msgs = message as unknown[];
            const errorArg =
                code instanceof Error
                    ? code
                    : msgs.find((m): m is Error => m instanceof Error);
            if (errorArg) {
                console.error('[auth][error]', extractErrorDetails(errorArg));
            } else {
                console.error(
                    '[auth][error]',
                    code,
                    ...formatAuthLogArgs(msgs, {
                        depth: 10,
                        showHidden: true,
                        expandErrors: true,
                    })
                );
            }
        },
        warn(code, ...message) {
            console.warn(
                '[auth][warn]',
                code,
                ...formatAuthLogArgs(message, { depth: 10, showHidden: true })
            );
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
