import {
    databaseTargetFromUrl,
    targetsIdentifySameDatabase,
} from './databaseTarget.mjs';

export type DeploymentReadinessCheck = {
    group: string;
    ok: boolean;
    required: boolean;
    configured: boolean;
    missing: string[];
    warnings: string[];
};

export type DeploymentReadiness = {
    ok: boolean;
    checks: DeploymentReadinessCheck[];
};

export type ReadinessEnv = Record<string, string | undefined>;

export type ReadinessProfile = 'production' | 'local';

export type VercelReadinessConfiguration = {
    hasCron: boolean;
    queueTopic: string | null;
    functionRegions: string[];
};

export type RuntimeReadinessOptions = {
    env: ReadinessEnv;
    vercel: VercelReadinessConfiguration;
    expectedQueueTopic: string;
    profile?: ReadinessProfile;
};

export function evaluateDeploymentReadiness({
    env,
    vercel,
    expectedQueueTopic,
    profile = 'production',
}: RuntimeReadinessOptions): DeploymentReadiness {
    const checks = [
        databaseReadiness(env, profile),
        authReadiness(env),
        stripeReadiness(env),
        adminOpsReadiness(env),
        cronReadiness(env, vercel),
        queueReadiness(env, vercel, expectedQueueTopic, profile),
        emailReadiness(env, profile),
        pushReadiness(env, profile),
    ];

    return {
        ok: checks.every((check) => check.ok),
        checks,
    };
}

export function readVercelReadinessConfiguration(json: {
    crons?: Array<{ path?: string }>;
    regions?: string[];
    functions?: Record<
        string,
        { experimentalTriggers?: Array<{ topic?: string }> }
    >;
}): VercelReadinessConfiguration {
    const trigger = Object.values(json.functions ?? {})
        .flatMap((value) => value.experimentalTriggers ?? [])
        .find((value) => value.topic?.trim());

    return {
        hasCron: (json.crons ?? []).some((cron) => Boolean(cron.path?.trim())),
        queueTopic: trigger?.topic?.trim() ?? null,
        functionRegions: Array.from(
            new Set((json.regions ?? []).map((region) => region.trim()).filter(Boolean))
        ),
    };
}

function databaseReadiness(
    env: ReadinessEnv,
    profile: ReadinessProfile
): DeploymentReadinessCheck {
    const missing = missingEnv(env, ['DATABASE_URL', 'DIRECT_URL']);
    const warnings: string[] = [];
    const databaseUrl = parsePostgresUrl(env.DATABASE_URL, 'DATABASE_URL', warnings);
    const directUrl = parsePostgresUrl(env.DIRECT_URL, 'DIRECT_URL', warnings);

    if (profile === 'production' && databaseUrl) {
        if (!isPoolerUrl(databaseUrl)) {
            warnings.push('DATABASE_URL must use a pooled runtime URL');
        }
        if (databaseUrl.searchParams.get('pgbouncer') !== 'true') {
            warnings.push('DATABASE_URL pooler URL must include pgbouncer=true');
        }
        const connectionLimit = Number(
            databaseUrl.searchParams.get('connection_limit')
        );
        if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 2) {
            warnings.push(
                'DATABASE_URL pooler URL must include connection_limit=1 or connection_limit=2'
            );
        }
        if (directUrl && isPoolerUrl(directUrl)) {
            warnings.push('DIRECT_URL must use a direct, non-pooled database URL');
        }
    }

    if (
        databaseUrl &&
        directUrl &&
        !targetsIdentifySameDatabase(
            databaseTargetFromUrl(databaseUrl),
            databaseTargetFromUrl(directUrl)
        )
    ) {
        warnings.push('DATABASE_URL and DIRECT_URL identify different logical databases');
    }

    return check('database', true, missing, warnings);
}

function authReadiness(env: ReadinessEnv): DeploymentReadinessCheck {
    const missing = missingEnv(env, ['NEXTAUTH_SECRET']);
    if (!hasAnyEnv(env, ['BACKRANQ_APP_URL', 'NEXTAUTH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'])) {
        missing.push('BACKRANQ_APP_URL or NEXTAUTH_URL');
    }

    const warnings = providerPairWarnings(env, [
        ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
        ['GITHUB_ID', 'GITHUB_SECRET'],
        ['LICHESS_CLIENT_ID', 'LICHESS_CLIENT_SECRET'],
    ]);
    return check('auth', true, missing, warnings);
}

function stripeReadiness(env: ReadinessEnv): DeploymentReadinessCheck {
    const missing = missingEnv(env, [
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_PRICE_PLUS_MONTHLY',
        'STRIPE_PRICE_PRO_MONTHLY',
    ]);
    const warnings =
        env.STRIPE_PRICE_PLUS_MONTHLY?.trim() &&
        env.STRIPE_PRICE_PRO_MONTHLY?.trim() &&
        env.STRIPE_PRICE_PLUS_MONTHLY.trim() === env.STRIPE_PRICE_PRO_MONTHLY.trim()
            ? ['Stripe Plus and Pro price IDs must be distinct']
            : [];
    return check('stripe', true, missing, warnings);
}

function adminOpsReadiness(env: ReadinessEnv): DeploymentReadinessCheck {
    const missing = hasAnyEnv(env, ['BACKRANQ_ADMIN_API_SECRET', 'ADMIN_API_SECRET'])
        ? []
        : ['BACKRANQ_ADMIN_API_SECRET'];
    return check('adminOps', true, missing, []);
}

function cronReadiness(
    env: ReadinessEnv,
    vercel: VercelReadinessConfiguration
): DeploymentReadinessCheck {
    const missing = vercel.hasCron && !env.CRON_SECRET?.trim() ? ['CRON_SECRET'] : [];
    return check('cron', vercel.hasCron, missing, []);
}

function queueReadiness(
    env: ReadinessEnv,
    vercel: VercelReadinessConfiguration,
    expectedQueueTopic: string,
    profile: ReadinessProfile
): DeploymentReadinessCheck {
    const warnings: string[] = [];
    const configuredRegion = env.BACKRANQ_QUEUE_REGION?.trim().toLowerCase();
    const missing =
        profile === 'production' && !configuredRegion
            ? ['BACKRANQ_QUEUE_REGION']
            : [];
    if (!vercel.queueTopic) {
        warnings.push('vercel.json has no queue trigger topic');
    } else if (vercel.queueTopic !== expectedQueueTopic) {
        warnings.push(
            `vercel.json queue topic ${vercel.queueTopic} does not match ${expectedQueueTopic}`
        );
    }
    if (
        profile === 'production' &&
        env.BACKRANQ_DISABLE_VERCEL_QUEUE === 'true'
    ) {
        warnings.push('Vercel Queue is disabled in production');
    }
    if (profile === 'production' && env.BACKRANQ_QUEUE_SMOKE_MODE === 'true') {
        warnings.push('Queue smoke mode must not be enabled in production');
    }
    const configuredRegionIsValid =
        configuredRegion != null && /^[a-z]{3}\d$/.test(configuredRegion);
    if (configuredRegion && !configuredRegionIsValid) {
        warnings.push(
            'BACKRANQ_QUEUE_REGION must be an explicit Vercel region code such as iad1 or dub1'
        );
    }
    if (vercel.functionRegions.length !== 1) {
        warnings.push(
            'vercel.json must configure exactly one Function region for regional Queue delivery'
        );
    } else if (
        configuredRegionIsValid &&
        configuredRegion &&
        configuredRegion !== vercel.functionRegions[0]
    ) {
        warnings.push(
            `BACKRANQ_QUEUE_REGION (${configuredRegion}) must match the Function region (${vercel.functionRegions[0]})`
        );
    }
    return check('queues', true, missing, warnings);
}

function emailReadiness(
    env: ReadinessEnv,
    profile: ReadinessProfile
): DeploymentReadinessCheck {
    const names = [
        'SMTP2GO_API_KEY',
        'SMTP2GO_WEBHOOK_SECRET',
        'BACKRANQ_EMAIL_FROM',
        'NOTIFICATION_UNSUBSCRIBE_SECRET',
    ];
    const configured = names.some((name) => Boolean(env[name]?.trim()));
    const required = profile === 'production' || configured;
    return check('email', required, required ? missingEnv(env, names) : [], []);
}

function pushReadiness(
    env: ReadinessEnv,
    profile: ReadinessProfile
): DeploymentReadinessCheck {
    const names = [
        'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
        'VAPID_PRIVATE_KEY',
        'VAPID_SUBJECT',
    ];
    const configured = names.some((name) => Boolean(env[name]?.trim()));
    const required = profile === 'production' || configured;
    return check('push', required, required ? missingEnv(env, names) : [], []);
}

function check(
    group: string,
    required: boolean,
    missing: string[],
    warnings: string[]
): DeploymentReadinessCheck {
    return {
        group,
        required,
        configured: missing.length === 0,
        missing,
        warnings,
        ok: missing.length === 0 && warnings.length === 0,
    };
}

function missingEnv(env: ReadinessEnv, names: string[]) {
    return names.filter((name) => !env[name]?.trim());
}

function hasAnyEnv(env: ReadinessEnv, names: string[]) {
    return names.some((name) => Boolean(env[name]?.trim()));
}

function providerPairWarnings(env: ReadinessEnv, pairs: string[][]) {
    const warnings: string[] = [];
    for (const [id, secret] of pairs) {
        if (Boolean(env[id]?.trim()) !== Boolean(env[secret]?.trim())) {
            warnings.push(`${id} and ${secret} must be configured together`);
        }
    }
    return warnings;
}

function parsePostgresUrl(
    value: string | undefined,
    label: string,
    warnings: string[]
) {
    if (!value?.trim()) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
            warnings.push(`${label} must use the postgresql protocol`);
            return null;
        }
        return url;
    } catch {
        warnings.push(`${label} must be a valid PostgreSQL URL`);
        return null;
    }
}

function isPoolerUrl(url: URL) {
    return (
        url.hostname.endsWith('.pooler.supabase.com') ||
        (url.hostname.endsWith('.neon.tech') &&
            url.hostname.split('.')[0]?.endsWith('-pooler') === true) ||
        url.port === '6543'
    );
}
