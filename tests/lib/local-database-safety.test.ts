import { describe, expect, it } from 'vitest';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertSafeLocalAuthSeedConfig } from '../../scripts/lib/local-database-safety.mjs';
import { writePrivateLocalJson } from '../../scripts/lib/private-local-file.mjs';

const localUrl =
    'postgresql://backranq:backranq@127.0.0.1:55432/backranq_local';

function config(overrides: Record<string, unknown> = {}) {
    return {
        environment: {},
        appUrl: 'http://127.0.0.1:3000',
        databaseUrl: localUrl,
        directUrl: localUrl,
        email: 'stripe-smoke@backranq.local',
        ...overrides,
    };
}

describe('local auth seed safety', () => {
    it('allows a dedicated identity in one local disposable database', () => {
        expect(() => assertSafeLocalAuthSeedConfig(config())).not.toThrow();
    });

    it('rejects remote, mismatched, and non-disposable databases', () => {
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({
                    databaseUrl:
                        'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres',
                })
            )
        ).toThrow(/loopback/);
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({
                    directUrl:
                        'postgresql://backranq:backranq@127.0.0.1:55432/other_test',
                })
            )
        ).toThrow(/same local database/);
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({
                    databaseUrl:
                        'postgresql://backranq:backranq@127.0.0.1:55432/backranq',
                    directUrl:
                        'postgresql://backranq:backranq@127.0.0.1:55432/backranq',
                })
            )
        ).toThrow(/ending in local, e2e, or test/);
    });

    it('rejects production runtimes, remote apps, and real identities', () => {
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({ environment: { NODE_ENV: 'production' } })
            )
        ).toThrow(/production runtime/);
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({ appUrl: 'https://backranq.xyz' })
            )
        ).toThrow(/non-local app/);
        expect(() =>
            assertSafeLocalAuthSeedConfig(
                config({ email: 'person@example.com' })
            )
        ).toThrow(/@backranq\.local/);
    });

    it.skipIf(process.platform === 'win32')(
        'hardens and atomically replaces an existing auth-session file',
        () => {
            const root = mkdtempSync(join(tmpdir(), 'backranq-auth-session-'));
            const directory = join(root, '.backranq-local');
            const file = join(directory, 'auth-session.json');
            try {
                mkdirSync(directory, { mode: 0o755 });
                writeFileSync(file, '{"stale":true}\n', { mode: 0o644 });
                chmodSync(directory, 0o755);
                chmodSync(file, 0o644);

                expect(
                    writePrivateLocalJson(directory, 'auth-session.json', {
                        cookie: 'private',
                    })
                ).toBe(file);

                expect(statSync(directory).mode & 0o777).toBe(0o700);
                expect(statSync(file).mode & 0o777).toBe(0o600);
                expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
                    cookie: 'private',
                });
            } finally {
                rmSync(root, { force: true, recursive: true });
            }
        }
    );
});
