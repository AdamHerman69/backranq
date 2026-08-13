import { describe, expect, it, vi } from 'vitest';
import { acquireTransactionAdvisoryLock } from '@/lib/db/advisoryLock';

describe('transaction advisory lock', () => {
    it('forces PostgreSQL to execute the void lock behind a typed row', async () => {
        const queryRaw = vi.fn().mockResolvedValue([{ acquired: true }]);

        await acquireTransactionAdvisoryLock(
            { $queryRaw: queryRaw } as never,
            'analysis-dispatch:user-1'
        );

        const sql = queryRaw.mock.calls[0]?.[0] as {
            strings: readonly string[];
            values: readonly unknown[];
        };
        expect(sql.strings.join(' ')).toContain(
            'WITH "backranq_advisory_lock" AS MATERIALIZED'
        );
        expect(sql.strings.join(' ')).toContain(
            'SELECT TRUE AS "acquired"'
        );
        expect(sql.values).toEqual(['analysis-dispatch:user-1']);
    });

    it('fails closed when the lock query does not return its typed sentinel', async () => {
        const queryRaw = vi.fn().mockResolvedValue([]);

        await expect(
            acquireTransactionAdvisoryLock(
                { $queryRaw: queryRaw } as never,
                'push-subscription:owner:user-1'
            )
        ).rejects.toThrow('was not acquired');
    });
});
