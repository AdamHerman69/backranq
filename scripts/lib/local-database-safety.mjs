import {
    databaseFingerprint,
    databaseTarget,
    targetsIdentifySameDatabase,
} from './e2e-database-safety.mjs';

const LOCAL_DATABASE_NAME = /(?:^|[_-])(local|e2e|test)$/i;
const LOCAL_APP_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertSafeLocalAuthSeedConfig({
    environment,
    appUrl,
    databaseUrl,
    directUrl,
    email,
}) {
    if (
        environment.NODE_ENV === 'production' ||
        environment.VERCEL_ENV === 'production' ||
        environment.VERCEL === '1'
    ) {
        throw new Error('Refusing to seed an auth session in a production runtime.');
    }

    let parsedAppUrl;
    try {
        parsedAppUrl = new URL(appUrl);
    } catch {
        throw new Error('BACKRANQ_APP_URL or NEXTAUTH_URL must be a valid local URL.');
    }
    if (
        !['http:', 'https:'].includes(parsedAppUrl.protocol) ||
        !LOCAL_APP_HOSTS.has(parsedAppUrl.hostname)
    ) {
        throw new Error('Refusing to seed an auth session for a non-local app URL.');
    }

    const database = databaseTarget(databaseUrl, 'DATABASE_URL');
    const direct = databaseTarget(directUrl, 'DIRECT_URL');
    if (!database.isLocal || !direct.isLocal) {
        throw new Error('Local auth seeding requires loopback DATABASE_URL and DIRECT_URL.');
    }
    if (!targetsIdentifySameDatabase(database, direct)) {
        throw new Error(
            `DATABASE_URL (${databaseFingerprint(database)}) and DIRECT_URL (${databaseFingerprint(direct)}) must identify the same local database.`
        );
    }
    if (!LOCAL_DATABASE_NAME.test(database.database)) {
        throw new Error(
            'Local auth seeding requires a database name ending in local, e2e, or test.'
        );
    }
    if (!/@backranq\.local$/i.test(email)) {
        throw new Error('Local auth seeding only accepts a dedicated @backranq.local identity.');
    }

    return { databaseFingerprint: databaseFingerprint(database) };
}
