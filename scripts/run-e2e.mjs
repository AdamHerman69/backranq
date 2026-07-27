#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { assertSafeE2eDatabaseConfig } from './lib/e2e-database-safety.mjs';

const root = process.cwd();
const composeFile = path.join(root, 'docker-compose.e2e.yml');
const localDatabaseUrl =
    'postgresql://backranq_e2e:backranq_e2e@127.0.0.1:55432/backranq_e2e?schema=public';
const useExternalDatabase =
    process.env.BACKRANQ_E2E_USE_EXTERNAL_DATABASE === 'true';
const keepDatabase = process.env.BACKRANQ_E2E_KEEP_DB === 'true';

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
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: root,
            env,
            stdio: 'inherit',
            ...options,
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${command} exited after signal ${signal}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`${command} exited with code ${code}`));
                return;
            }
            resolve();
        });
    });
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
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    NEXTAUTH_URL: baseUrl,
    BACKRANQ_APP_URL: baseUrl,
    NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ??
        'backranq-local-e2e-secret-not-for-production',
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
    await run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], env);
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    await cleanup();
}
