#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { assertSafeE2eDatabaseConfig } from './lib/e2e-database-safety.mjs';
import { runCommand } from './lib/run-command.mjs';

const root = process.cwd();
const composeFile = path.join(root, 'docker-compose.e2e.yml');
const localDatabaseUrl =
    'postgresql://backranq_e2e:backranq_e2e@127.0.0.1:55432/backranq_e2e?schema=public';
const useExternalDatabase =
    process.env.BACKRANQ_E2E_USE_EXTERNAL_DATABASE === 'true';
const keepDatabase = process.env.BACKRANQ_E2E_KEEP_DB === 'true';
const commandArguments = process.argv.slice(2);
const skipBuild = commandArguments.includes('--skip-build');
const playwrightArguments = commandArguments.filter(
    (argument) => argument !== '--skip-build'
);

function readEnvFile(file) {
    if (!fs.existsSync(file)) return {};
    const values = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line
            .trim()
            .match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

function run(command, args, env, options = {}) {
    return runCommand(command, args, env, { cwd: root, ...options });
}

const fileEnv = useExternalDatabase
    ? readEnvFile(path.join(root, '.env.e2e.local'))
    : {};
const externalDatabaseUrl =
    process.env.E2E_DATABASE_URL ?? fileEnv.E2E_DATABASE_URL;
const externalDirectUrl =
    process.env.E2E_DIRECT_URL ?? fileEnv.E2E_DIRECT_URL;

if (useExternalDatabase && !externalDatabaseUrl) {
    console.error(
        'BACKRANQ_E2E_USE_EXTERNAL_DATABASE=true requires E2E_DATABASE_URL.'
    );
    process.exit(1);
}

const databaseUrl = useExternalDatabase
    ? externalDatabaseUrl
    : localDatabaseUrl;
const directUrl = useExternalDatabase
    ? (externalDirectUrl ?? externalDatabaseUrl)
    : localDatabaseUrl;
const safetyEnvironment = {
    ...fileEnv,
    ...process.env,
};

try {
    assertSafeE2eDatabaseConfig({
        useExternalDatabase,
        databaseUrl,
        directUrl,
        environment: safetyEnvironment,
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

const baseUrl =
    process.env.BACKRANQ_E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const env = {
    ...safetyEnvironment,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    NEXTAUTH_URL: baseUrl,
    BACKRANQ_APP_URL: baseUrl,
    NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ??
        'backranq-local-e2e-secret-not-for-production',
    // Browser tests must never inherit credentials capable of external writes.
    // Dedicated live-provider and billing smoke commands own those integrations.
    BACKRANQ_DISABLE_VERCEL_QUEUE: 'true',
    SMTP2GO_API_KEY: 'e2e-invalid-key-never-send',
    SMTP2GO_WEBHOOK_SECRET: '',
    BACKRANQ_EMAIL_FROM: 'Backranq E2E <no-reply@example.invalid>',
    NOTIFICATION_UNSUBSCRIBE_SECRET: 'e2e-unsubscribe-secret',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_PLUS_MONTHLY: '',
    STRIPE_PRICE_PRO_MONTHLY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GITHUB_ID: '',
    GITHUB_SECRET: '',
    LICHESS_ENABLED: 'false',
    LICHESS_CLIENT_ID: '',
    LICHESS_CLIENT_SECRET: '',
    NEXT_PUBLIC_SUPABASE_URL: '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    VERCEL_OIDC_TOKEN: '',
    VERCEL_DEPLOYMENT_ID: '',
    VERCEL_ENV: '',
    // The global analysis bar performs independent polling and can resize the
    // sticky header while pointer-based board tests are in progress. Dedicated
    // unit/integration coverage owns that feature; keep authenticated browser
    // journeys deterministic and free of external queue traffic.
    BACKRANQ_E2E_AUTH: 'true',
    BACKRANQ_E2E_DATABASE_MODE: useExternalDatabase ? 'external' : 'local',
};

let databaseStarted = false;

async function cleanup() {
    if (!databaseStarted || keepDatabase) return;
    await run(
        'docker',
        ['compose', '-f', composeFile, 'down', '--volumes', '--remove-orphans'],
        env
    ).catch((error) => {
        console.error(`E2E database cleanup failed: ${error.message}`);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        void cleanup().finally(() => {
            process.kill(process.pid, signal);
        });
    });
}

try {
    if (!useExternalDatabase) {
        databaseStarted = true;
        await run(
            'docker',
            ['compose', '-f', composeFile, 'up', '-d', '--wait'],
            env
        );
        await run(
            'docker',
            [
                'compose',
                '-f',
                composeFile,
                'exec',
                '-T',
                'postgres',
                'psql',
                '-v',
                'ON_ERROR_STOP=1',
                '-U',
                'backranq_e2e',
                '-d',
                'backranq_e2e',
                '-c',
                `DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END
$roles$;`,
            ],
            env
        );
    }

    await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], env);
    if (!skipBuild) {
        await run('pnpm', ['build'], { ...env, NODE_ENV: 'production' });
    }
    await run(
        'pnpm',
        ['exec', 'playwright', 'test', ...playwrightArguments],
        env,
        { captureRuntimeLogs: true }
    );
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    await cleanup();
}
