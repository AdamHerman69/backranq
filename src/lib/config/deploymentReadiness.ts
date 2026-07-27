import fs from 'node:fs';
import path from 'node:path';
import { BACKRANQ_QUEUE_TOPIC } from '@/lib/queues/backranq';

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

type ReadinessEnv = Record<string, string | undefined>;

export function getDeploymentReadiness(
    env: ReadinessEnv = process.env,
    cwd = process.cwd()
): DeploymentReadiness {
    const vercel = readVercelJson(cwd);
    const checks = [
        databaseReadiness(env),
        stripeReadiness(env),
        adminOpsReadiness(env),
        cronReadiness(env, vercel),
        queueReadiness(env, vercel),
        reconciliationReadiness(cwd),
    ];

    return {
        ok: checks.every((check) => check.ok),
        checks,
    };
}

function databaseReadiness(env: ReadinessEnv): DeploymentReadinessCheck {
    const missing = missingEnv(env, ['DATABASE_URL', 'DIRECT_URL']);
    return check('database', true, missing, []);
}

function stripeReadiness(env: ReadinessEnv): DeploymentReadinessCheck {
    const missing = missingEnv(env, [
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_PRICE_PLUS_MONTHLY',
        'STRIPE_PRICE_PRO_MONTHLY',
    ]);
    if (!hasAnyEnv(env, ['BACKRANQ_APP_URL', 'NEXTAUTH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'])) {
        missing.push('BACKRANQ_APP_URL or NEXTAUTH_URL');
    }
    const warnings =
        env.STRIPE_PRICE_PLUS_MONTHLY &&
        env.STRIPE_PRICE_PRO_MONTHLY &&
        env.STRIPE_PRICE_PLUS_MONTHLY === env.STRIPE_PRICE_PRO_MONTHLY
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
    vercel: { hasSyncCron: boolean }
): DeploymentReadinessCheck {
    const missing = vercel.hasSyncCron && !env.CRON_SECRET ? ['CRON_SECRET'] : [];
    return check('cron', vercel.hasSyncCron, missing, []);
}

function queueReadiness(
    env: ReadinessEnv,
    vercel: { queueTopic: string | null }
): DeploymentReadinessCheck {
    const warnings: string[] = [];
    if (vercel.queueTopic && vercel.queueTopic !== BACKRANQ_QUEUE_TOPIC) {
        warnings.push(
            `vercel.json queue topic ${vercel.queueTopic} does not match ${BACKRANQ_QUEUE_TOPIC}`
        );
    }
    if (
        env.NODE_ENV === 'production' &&
        env.BACKRANQ_DISABLE_VERCEL_QUEUE === 'true'
    ) {
        warnings.push('Vercel Queue is disabled in production');
    }
    return check('queues', true, [], warnings);
}

function reconciliationReadiness(cwd: string): DeploymentReadinessCheck {
    const scripts = [
        'scripts/reconcile-credit-ledger.mjs',
        'scripts/smoke-stripe-billing.mjs',
    ];
    const missing = scripts.filter((script) => !fs.existsSync(path.join(cwd, script)));
    return check('reconciliation', true, missing, []);
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

function readVercelJson(cwd: string) {
    try {
        const file = path.join(cwd, 'vercel.json');
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            crons?: Array<{ path?: string }>;
            functions?: Record<
                string,
                { experimentalTriggers?: Array<{ topic?: string }> }
            >;
        };
        const trigger = Object.values(json.functions ?? {})
            .flatMap((value) => value.experimentalTriggers ?? [])
            .find((value) => value.topic);
        return {
            hasSyncCron: (json.crons ?? []).some(
                (cron) => cron.path === '/api/cron/sync-games'
            ),
            queueTopic: trigger?.topic ?? null,
        };
    } catch {
        return { hasSyncCron: false, queueTopic: null };
    }
}
