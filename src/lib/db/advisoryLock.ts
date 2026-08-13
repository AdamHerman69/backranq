import { Prisma } from '@prisma/client';

type AdvisoryLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Acquire a transaction-scoped PostgreSQL advisory lock without exposing its
 * `void` return type to Prisma's deserializer.
 */
export async function acquireTransactionAdvisoryLock(
    tx: AdvisoryLockClient,
    key: string
) {
    if (!key) throw new Error('Advisory lock key is required');
    const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`
            WITH "backranq_advisory_lock" AS MATERIALIZED (
                SELECT pg_advisory_xact_lock(
                    hashtextextended(${key}, 0)
                )
            )
            SELECT TRUE AS "acquired"
            FROM "backranq_advisory_lock"
        `
    );
    if (rows[0]?.acquired !== true) {
        throw new Error('PostgreSQL advisory lock was not acquired');
    }
}
