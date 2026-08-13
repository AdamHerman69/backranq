const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function parseDatabaseTarget(rawUrl, label = 'Database URL') {
    if (!rawUrl) {
        throw new Error(`${label} is required.`);
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

    return databaseTargetFromUrl(url);
}

export function databaseTargetFromUrl(url) {
    const database =
        decodeURIComponent(url.pathname.replace(/^\/+/, '')) ||
        decodeURIComponent(url.username);

    return {
        database,
        schema: url.searchParams.get('schema')?.trim() || 'public',
        host: url.host.toLowerCase(),
        hostname: url.hostname.toLowerCase(),
        port: url.port || '5432',
        isLocal: LOCAL_DATABASE_HOSTS.has(url.hostname.toLowerCase()),
        username: decodeURIComponent(url.username),
    };
}

export function databaseFingerprint(target) {
    return `${target.username}@${target.host}/${target.database}?schema=${target.schema}`;
}

export function targetsIdentifySameDatabase(runtime, direct) {
    if (
        runtime.database !== direct.database ||
        runtime.schema !== direct.schema
    ) {
        return false;
    }

    const runtimeSupabaseRef = supabaseProjectRef(runtime);
    const directSupabaseRef = supabaseProjectRef(direct);
    if (runtimeSupabaseRef || directSupabaseRef) {
        return Boolean(
            runtimeSupabaseRef &&
                directSupabaseRef &&
                runtimeSupabaseRef === directSupabaseRef
        );
    }

    const runtimeNeonHost = neonDirectHost(runtime.hostname);
    const directNeonHost = neonDirectHost(direct.hostname);
    if (runtimeNeonHost || directNeonHost) {
        return Boolean(
            runtimeNeonHost &&
                directNeonHost &&
                runtimeNeonHost === directNeonHost
        );
    }

    return (
        runtime.hostname === direct.hostname && runtime.port === direct.port
    );
}

function supabaseProjectRef(target) {
    if (target.hostname.endsWith('.pooler.supabase.com')) {
        return target.username.match(/^postgres\.([A-Za-z0-9_-]+)$/)?.[1] ?? null;
    }

    return (
        target.hostname.match(/^db\.([A-Za-z0-9_-]+)\.supabase\.co$/)?.[1] ??
        null
    );
}

function neonDirectHost(hostname) {
    if (!hostname.endsWith('.neon.tech')) return null;
    const labels = hostname.split('.');
    labels[0] = labels[0].replace(/-pooler$/, '');
    return labels.join('.');
}
