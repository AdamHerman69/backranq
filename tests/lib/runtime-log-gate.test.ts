import { describe, expect, it } from 'vitest';

import {
    findUnexpectedRuntimeLogSignatures,
    formatUnexpectedRuntimeLogFindings,
} from '../../scripts/lib/runtime-log-gate.mjs';
import { runCommand } from '../../scripts/lib/run-command.mjs';

describe('production E2E runtime log gate', () => {
    it('accepts normal Next.js and Playwright output', () => {
        const output = [
            '▲ Next.js 16.2.11',
            '✓ Ready in 432ms',
            '  12 passed (18.2s)',
        ].join('\n');

        expect(findUnexpectedRuntimeLogSignatures(output)).toEqual([]);
    });

    it('detects the production runtime failure sentinels', () => {
        const findings = findUnexpectedRuntimeLogSignatures(
            [
                'TypeError: fetch is not a function',
                'PrismaClientKnownRequestError: P2028 Transaction API error',
                'UnhandledPromiseRejection: worker failed',
                'uncaughtException Error: process crashed',
                '[auth][error] AdapterError',
                "Can't reach database server at db.internal:5432",
            ].join('\n')
        );

        expect(new Set(findings.map((finding) => finding.id))).toEqual(
            new Set([
                'node-fetch-runtime-mismatch',
                'prisma-transaction-timeout',
                'prisma-runtime-error',
                'unhandled-rejection',
                'uncaught-exception',
                'auth-runtime-error',
                'database-runtime-error',
            ])
        );
        expect(formatUnexpectedRuntimeLogFindings(findings)).toContain(
            'node-fetch-runtime-mismatch: TypeError: fetch is not a function'
        );
    });

    it('strips terminal color codes before matching and reporting', () => {
        expect(
            findUnexpectedRuntimeLogSignatures(
                '\u001B[31m[auth][error] AuthError: invalid adapter state\u001B[0m'
            )
        ).toEqual([
            {
                id: 'auth-runtime-error',
                line: '[auth][error] AuthError: invalid adapter state',
            },
        ]);
    });

    it('fails a successful child on a sentinel while preserving a real child exit code', async () => {
        const sink = { write: () => true };
        const options = {
            captureRuntimeLogs: true,
            cwd: process.cwd(),
            stdout: sink,
            stderr: sink,
        };

        await expect(
            runCommand(
                process.execPath,
                ['-e', "console.error('TypeError: fetch is not a function')"],
                process.env,
                options
            )
        ).rejects.toThrow(
            /completed successfully[\s\S]*node-fetch-runtime-mismatch/
        );

        await expect(
            runCommand(
                process.execPath,
                [
                    '-e',
                    "console.error('[auth][error] AdapterError'); process.exit(17)",
                ],
                process.env,
                options
            )
        ).rejects.toThrow(/exited with code 17[\s\S]*auth-runtime-error/);
    });
});
