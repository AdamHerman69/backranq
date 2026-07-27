const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REMOTE_WRITE_CONFIRMATION = 'DELETE_ONLY_BACKRANQ_E2E_FIXTURES';

function databaseTarget(rawUrl, label) {
    if (!rawUrl) {
        throw new Error(`${label} is required for E2E tests.`);
    }

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(`${label} must be a valid PostgreSQL URL.`);
    }

    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
        throw new Error(`${label} must use the postgresql protocol.`);
    }

    return {
        database: decodeURIComponent(url.pathname.replace(/^\/+/, '')),
        host: url.host,
        hostname: url.hostname,
        isLocal: LOCAL_DATABASE_HOSTS.has(url.hostname),
        username: decodeURIComponent(url.username),
    };
}

function databaseFingerprint(target) {
    return `${target.username}@${target.host}/${target.database}`;
}

function supabaseProjectRef(target) {
    if (target.hostname.endsWith('.pooler.supabase.com')) {
        const match = target.username.match(/^postgres\.([A-Za-z0-9_-]+)$/);
        return match?.[1] ?? null;
    }

    const directMatch = target.hostname.match(
        /^db\.([A-Za-z0-9_-]+)\.supabase\.co$/
    );
    return directMatch?.[1] ?? null;
}

function targetsIdentifySameDatabase(database, direct) {
    if (databaseFingerprint(database) === databaseFingerprint(direct)) {
        return true;
    }

    const databaseProjectRef = supabaseProjectRef(database);
    const directProjectRef = supabaseProjectRef(direct);
    return Boolean(
        databaseProjectRef &&
            directProjectRef &&
            databaseProjectRef === directProjectRef &&
            database.database === direct.database
    );
}

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

    if (!targetsIdentifySameDatabase(database, direct)) {
        throw new Error(
            `DATABASE_URL (${databaseFingerprint(database)}) and DIRECT_URL (${databaseFingerprint(direct)}) do not identify the same disposable database.`
        );
    }
}
