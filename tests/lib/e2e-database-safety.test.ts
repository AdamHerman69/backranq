import { describe, expect, it } from 'vitest';

import { assertSafeE2eDatabaseConfig } from '../../scripts/lib/e2e-database-safety.mjs';

const localUrl =
    'postgresql://backranq_e2e:backranq_e2e@127.0.0.1:55432/backranq_e2e';
const remoteDatabaseUrl =
    'postgresql://postgres.devbranchref:secret@aws-0-region.pooler.supabase.com:6543/postgres';
const remoteDirectUrl =
    'postgresql://postgres:secret@db.devbranchref.supabase.co:5432/postgres';

function externalEnvironment(
    overrides: Record<string, string | undefined> = {}
) {
    return {
        BACKRANQ_E2E_DATABASE_MODE: 'external',
        BACKRANQ_E2E_ALLOW_REMOTE: 'true',
        BACKRANQ_E2E_CONFIRM_DATA_WRITES:
            'DELETE_ONLY_BACKRANQ_E2E_FIXTURES',
        BACKRANQ_E2E_CONFIRM_DATABASE_HOSTS:
            'aws-0-region.pooler.supabase.com:6543,db.devbranchref.supabase.co:5432',
        ...overrides,
    };
}

describe('E2E database safety', () => {
    it('allows both local database targets in local mode', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: false,
                databaseUrl: localUrl,
                directUrl: localUrl,
                environment: {},
            })
        ).not.toThrow();
    });

    it('rejects a remote direct URL in local mode', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: false,
                databaseUrl: localUrl,
                directUrl: remoteDirectUrl,
                environment: {},
            })
        ).toThrow(/both DATABASE_URL and DIRECT_URL/);
    });

    it('rejects external targets before confirmation', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: true,
                databaseUrl: remoteDatabaseUrl,
                directUrl: remoteDirectUrl,
                environment: {
                    BACKRANQ_E2E_DATABASE_MODE: 'external',
                },
            })
        ).toThrow(/require the documented/);
    });

    it('requires explicit confirmation for both external hosts', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: true,
                databaseUrl: remoteDatabaseUrl,
                directUrl: remoteDirectUrl,
                environment: externalEnvironment({
                    BACKRANQ_E2E_CONFIRM_DATABASE_HOSTS:
                        'aws-0-region.pooler.supabase.com:6543',
                }),
            })
        ).toThrow(/db\.devbranchref\.supabase\.co:5432/);
    });

    it('allows fully confirmed external targets', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: true,
                databaseUrl: remoteDatabaseUrl,
                directUrl: remoteDirectUrl,
                environment: externalEnvironment(),
            })
        ).not.toThrow();
    });

    it('rejects pooled and direct URLs for different Supabase projects', () => {
        const mismatchedDirectUrl =
            'postgresql://postgres:secret@db.productionref.supabase.co:5432/postgres';

        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: true,
                databaseUrl: remoteDatabaseUrl,
                directUrl: mismatchedDirectUrl,
                environment: externalEnvironment({
                    BACKRANQ_E2E_CONFIRM_DATABASE_HOSTS:
                        'aws-0-region.pooler.supabase.com:6543,db.productionref.supabase.co:5432',
                }),
            })
        ).toThrow(/do not identify the same disposable database/);
    });

    it('rejects database commands in a production runtime', () => {
        expect(() =>
            assertSafeE2eDatabaseConfig({
                useExternalDatabase: true,
                databaseUrl: remoteDatabaseUrl,
                directUrl: remoteDirectUrl,
                environment: externalEnvironment({ NODE_ENV: 'production' }),
            })
        ).toThrow(/production runtime/);
    });
});
