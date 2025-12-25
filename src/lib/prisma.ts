import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// For serverless (Vercel), we need to limit Prisma connections to prevent
// Supabase pool exhaustion. The connection_limit parameter in DATABASE_URL
// should be set to 1-2 for serverless environments.
//
// If you use Supabase's PgBouncer pooler (common on Vercel), ensure your
// DATABASE_URL includes `pgbouncer=true` to avoid prepared statement errors.
const dbUrl = process.env.DATABASE_URL;
if (
    process.env.NODE_ENV === 'production' &&
    dbUrl &&
    (dbUrl.includes('pooler.supabase.com') || dbUrl.includes(':6543')) &&
    !dbUrl.includes('pgbouncer=true')
) {
    // eslint-disable-next-line no-console
    console.warn(
        '[prisma] DATABASE_URL looks like a Supabase pooler URL but is missing `pgbouncer=true`. ' +
            'This can cause errors like: prepared statement "s1" already exists.'
    );
}
export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === 'development'
                ? ['query', 'error', 'warn']
                : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
