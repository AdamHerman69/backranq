import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    envFileNames,
    loadEnvFiles,
} from '../../scripts/lib/load-env.mjs';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

function temporaryDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'backranq-env-'));
    directories.push(directory);
    return directory;
}

describe('loadEnvFiles', () => {
    it('matches Next precedence while preserving explicit process values', () => {
        const directory = temporaryDirectory();
        writeFileSync(join(directory, '.env'), 'VALUE=base\nBASE_ONLY=yes\n');
        writeFileSync(join(directory, '.env.development'), 'VALUE=mode\n');
        writeFileSync(join(directory, '.env.local'), 'VALUE=local\nLOCAL_ONLY=yes\n');
        writeFileSync(
            join(directory, '.env.development.local'),
            'VALUE=mode-local\nMODE_LOCAL_ONLY=yes\n'
        );
        const environment: Record<string, string | undefined> = {
            EXPLICIT: 'process',
        };

        loadEnvFiles(directory, environment, 'development');

        expect(environment).toMatchObject({
            VALUE: 'mode-local',
            BASE_ONLY: 'yes',
            LOCAL_ONLY: 'yes',
            MODE_LOCAL_ONLY: 'yes',
            EXPLICIT: 'process',
        });
    });

    it('does not load .env.local in test mode', () => {
        const directory = temporaryDirectory();
        writeFileSync(join(directory, '.env'), 'VALUE=base\n');
        writeFileSync(join(directory, '.env.local'), 'VALUE=local\n');
        writeFileSync(join(directory, '.env.test'), 'VALUE=test\n');
        const environment: Record<string, string | undefined> = {};

        loadEnvFiles(directory, environment, 'test');

        expect(environment.VALUE).toBe('test');
        expect(envFileNames('test')).not.toContain('.env.local');
    });

    it('unquotes values and ignores comments and malformed lines', () => {
        const directory = temporaryDirectory();
        writeFileSync(
            join(directory, '.env'),
            '# comment\nDOUBLE="two words"\nSINGLE=\'one word\'\nnot valid\n'
        );
        const environment: Record<string, string | undefined> = {};

        loadEnvFiles(directory, environment, 'development');

        expect(environment).toEqual({
            DOUBLE: 'two words',
            SINGLE: 'one word',
        });
    });
});
