#!/usr/bin/env node

import { spawn } from 'node:child_process';

import {
    databaseFingerprint,
    databaseTarget,
    targetsIdentifySameDatabase,
} from './lib/e2e-database-safety.mjs';
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

const timeoutMs = Number(process.env.BACKRANQ_MIGRATION_TIMEOUT_MS ?? 300_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('BACKRANQ_MIGRATION_TIMEOUT_MS must be an integer of at least 1000.');
}
const killGraceMs = Number(
    process.env.BACKRANQ_MIGRATION_KILL_GRACE_MS ?? 5_000
);
if (!Number.isInteger(killGraceMs) || killGraceMs < 10) {
    throw new Error(
        'BACKRANQ_MIGRATION_KILL_GRACE_MS must be an integer of at least 10.'
    );
}

const database = databaseTarget(process.env.DATABASE_URL, 'DATABASE_URL');
const direct = databaseTarget(process.env.DIRECT_URL, 'DIRECT_URL');
if (!targetsIdentifySameDatabase(database, direct)) {
    throw new Error(
        `Refusing migration because DATABASE_URL (${databaseFingerprint(database)}) and DIRECT_URL (${databaseFingerprint(direct)}) identify different databases.`
    );
}

console.log(`Running migrations against ${databaseFingerprint(direct)}.`);
await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], timeoutMs);
await run('pnpm', ['exec', 'prisma', 'migrate', 'status'], timeoutMs);
console.log('Migrations completed and migration history is current.');

function run(command, args, commandTimeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit',
            // A dedicated Unix process group lets the timeout terminate pnpm,
            // Prisma, and any database-engine descendants as one unit.
            detached: process.platform !== 'win32',
        });
        let timedOut = false;
        let forceKillTimeout;
        const timeout = setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child, 'SIGTERM');
            forceKillTimeout = setTimeout(() => {
                terminateProcessTree(child, 'SIGKILL');
                reject(
                    new Error(
                        `${command} ${args.join(' ')} timed out after ${commandTimeoutMs}ms`
                    )
                );
            }, killGraceMs);
        }, commandTimeoutMs);

        child.once('error', (error) => {
            clearTimeout(timeout);
            clearTimeout(forceKillTimeout);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            if (timedOut) {
                // A descendant may ignore SIGTERM after pnpm itself exits. The
                // grace timer owns final group termination and rejection.
                return;
            }
            clearTimeout(forceKillTimeout);
            if (signal) {
                reject(new Error(`${command} exited after signal ${signal}`));
            } else if (code !== 0) {
                reject(new Error(`${command} exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

function terminateProcessTree(child, signal) {
    if (!child.pid) return;

    if (process.platform === 'win32') {
        const killer = spawn(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true }
        );
        killer.once('error', () => child.kill(signal));
        return;
    }

    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
    }
}
