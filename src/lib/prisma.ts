import { PrismaClient } from '@prisma/client';
import { measurePrismaOperation } from '@/lib/performance/requestTrace';

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
    console.warn(
        '[prisma] DATABASE_URL looks like a Supabase pooler URL but is missing `pgbouncer=true`. ' +
            'This can cause errors like: prepared statement "s1" already exists.'
    );
}
function createPrismaClient() {
    const client = new PrismaClient({
        log:
            process.env.NODE_ENV === 'development'
                ? ['query', 'error', 'warn']
                : ['error'],
    }).$extends({
        query: {
            $allOperations({ args, query }) {
                return measurePrismaOperation(() => query(args));
            },
        },
    });
    // Query extensions intentionally remain an implementation detail. Keeping
    // the exported PrismaClient contract avoids leaking Prisma's extension
    // generic into the many narrow DB-client interfaces used by services.
    return client as unknown as PrismaClient;
}

const globalForPrisma = globalThis as unknown as {
    prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}
