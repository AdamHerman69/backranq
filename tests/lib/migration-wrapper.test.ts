import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const databaseUrl =
    'postgresql://backranq:backranq@127.0.0.1:55432/backranq_test';

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

function fakePnpm(body: string) {
    const directory = mkdtempSync(join(tmpdir(), 'backranq-migrate-'));
    directories.push(directory);
    const executable = join(directory, 'pnpm');
    writeFileSync(executable, `#!/bin/sh\n${body}\n`);
    chmodSync(executable, 0o755);
    return directory;
}

function run(directory: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(
        process.execPath,
        [join(process.cwd(), 'scripts/migrate-with-timeout.mjs')],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
                ...process.env,
                DATABASE_URL: databaseUrl,
                DIRECT_URL: databaseUrl,
                PATH: `${directory}${delimiter}${process.env.PATH}`,
                ...extraEnv,
            },
        }
    );
}

describe('migration wrapper', () => {
    it('propagates a Prisma migration failure instead of continuing', () => {
        const result = run(fakePnpm('exit 17'));

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain(
            'Migrations completed and migration history is current.'
        );
    });

    it('runs only supported deploy and status commands', () => {
        const directory = fakePnpm('printf "%s\\n" "$*" >> "$CAPTURE"');
        const capture = join(directory, 'arguments.txt');
        const result = run(directory, { CAPTURE: capture });

        expect(result.status).toBe(0);
        const argumentsLog = readFileSync(capture, 'utf8');
        expect(argumentsLog).toContain('exec prisma migrate deploy');
        expect(argumentsLog).toContain('exec prisma migrate status');
        expect(argumentsLog).not.toContain('--skip-seed');
    });

    it('accepts Neon pooler and direct URLs for the same logical database', () => {
        const directory = fakePnpm('exit 0');
        const result = run(directory, {
            DATABASE_URL:
                'postgresql://app:secret@ep-example-pooler.eu-central-1.aws.neon.tech/backranq?schema=public',
            DIRECT_URL:
                'postgresql://app:secret@ep-example.eu-central-1.aws.neon.tech/backranq?schema=public',
        });

        expect(result.status).toBe(0);
    });

    it('rejects URLs that differ only by selected schema', () => {
        const directory = fakePnpm('exit 0');
        const result = run(directory, {
            DATABASE_URL: `${databaseUrl}?schema=tenant_a`,
            DIRECT_URL: `${databaseUrl}?schema=public`,
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
            'identify different databases'
        );
    });

    it.skipIf(process.platform === 'win32')(
        'terminates a migration grandchild that ignores SIGTERM',
        () => {
            const directory = fakePnpm(
                '"$NODE_BINARY" "$GRANDCHILD_FIXTURE" &\nwait'
            );
            const fixture = join(directory, 'grandchild.mjs');
            const pidFile = join(directory, 'grandchild.pid');
            writeFileSync(
                fixture,
                [
                    "import { writeFileSync } from 'node:fs';",
                    "writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid));",
                    "process.on('SIGTERM', () => {});",
                    'setInterval(() => {}, 1_000);',
                ].join('\n')
            );

            const result = run(directory, {
                BACKRANQ_MIGRATION_TIMEOUT_MS: '1000',
                BACKRANQ_MIGRATION_KILL_GRACE_MS: '100',
                NODE_BINARY: process.execPath,
                GRANDCHILD_FIXTURE: fixture,
                GRANDCHILD_PID_FILE: pidFile,
            });

            expect(result.status).not.toBe(0);
            expect(`${result.stdout}${result.stderr}`).toContain(
                'timed out after 1000ms'
            );
            const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
            expect(Number.isInteger(grandchildPid)).toBe(true);
            expect(() => process.kill(grandchildPid, 0)).toThrow();
        },
        10_000
    );
});
