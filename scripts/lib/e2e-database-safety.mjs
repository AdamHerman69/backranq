import {
    databaseFingerprint,
    parseDatabaseTarget,
    targetsIdentifySameDatabase,
} from '../../src/lib/config/databaseTarget.mjs';

const REMOTE_WRITE_CONFIRMATION = 'DELETE_ONLY_BACKRANQ_E2E_FIXTURES';

export function databaseTarget(rawUrl, label) {
    return parseDatabaseTarget(rawUrl, label);
}

export { databaseFingerprint, targetsIdentifySameDatabase };

function confirmedHosts(value) {
    return new Set(
        (value ?? '')
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean)
    );
}

/**
 * Validate every database target before migrations, fixture writes, or cleanup.
 *
 * @param {{
 *   useExternalDatabase: boolean;
 *   databaseUrl: string | undefined;
 *   directUrl: string | undefined;
 *   environment: Record<string, string | undefined>;
 * }} options
 */
export function assertSafeE2eDatabaseConfig({
    useExternalDatabase,
    databaseUrl,
    directUrl,
    environment,
}) {
    if (
        environment.NODE_ENV === 'production' ||
        environment.VERCEL_ENV === 'production'
    ) {
        throw new Error(
            'Refusing to run E2E database commands in a production runtime.'
        );
    }

    const database = databaseTarget(databaseUrl, 'DATABASE_URL');
    const direct = databaseTarget(directUrl, 'DIRECT_URL');

    if (!useExternalDatabase) {
        if (!database.isLocal || !direct.isLocal) {
            throw new Error(
                'Local E2E mode requires both DATABASE_URL and DIRECT_URL to use localhost.'
            );
        }
        assertSameDisposableDatabase(database, direct);
        return;
    }

    if (
        environment.BACKRANQ_E2E_DATABASE_MODE !== 'external' ||
        environment.BACKRANQ_E2E_ALLOW_REMOTE !== 'true' ||
        environment.BACKRANQ_E2E_CONFIRM_DATA_WRITES !==
            REMOTE_WRITE_CONFIRMATION
    ) {
        throw new Error(
            'External E2E database commands require the documented mode, remote-write, and data-write confirmations.'
        );
    }

    const allowedHosts = confirmedHosts(
        environment.BACKRANQ_E2E_CONFIRM_DATABASE_HOSTS
    );
    for (const target of [database, direct]) {
        if (!allowedHosts.has(target.host)) {
            throw new Error(
                `External E2E database host ${target.host} was not explicitly confirmed.`
            );
        }
    }
    assertSameDisposableDatabase(database, direct);
}

function assertSameDisposableDatabase(database, direct) {
    if (!targetsIdentifySameDatabase(database, direct)) {
        throw new Error(
            `DATABASE_URL (${databaseFingerprint(database)}) and DIRECT_URL (${databaseFingerprint(direct)}) do not identify the same disposable database.`
        );
    }
}
