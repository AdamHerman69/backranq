import { spawn } from 'node:child_process';

import {
    findUnexpectedRuntimeLogSignatures,
    formatUnexpectedRuntimeLogFindings,
} from './runtime-log-gate.mjs';

export function runCommand(command, args, env, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            captureRuntimeLogs = false,
            stdout = process.stdout,
            stderr = process.stderr,
            ...spawnOptions
        } = options;
        let output = '';
        const child = spawn(command, args, {
            env,
            stdio: captureRuntimeLogs
                ? ['inherit', 'pipe', 'pipe']
                : 'inherit',
            ...spawnOptions,
        });
        child.on('error', reject);
        if (captureRuntimeLogs) {
            child.stdout.on('data', (chunk) => {
                output += chunk.toString();
                stdout.write(chunk);
            });
            child.stderr.on('data', (chunk) => {
                output += chunk.toString();
                stderr.write(chunk);
            });
        }
        child.on('close', (code, signal) => {
            const findings = captureRuntimeLogs
                ? findUnexpectedRuntimeLogSignatures(output)
                : [];
            const runtimeFailure = findings.length
                ? `\nUnexpected production runtime log signatures:\n${formatUnexpectedRuntimeLogFindings(findings)}`
                : '';
            if (signal) {
                reject(
                    new Error(
                        `${command} exited after signal ${signal}${runtimeFailure}`
                    )
                );
                return;
            }
            if (code !== 0) {
                reject(
                    new Error(`${command} exited with code ${code}${runtimeFailure}`)
                );
                return;
            }
            if (findings.length) {
                reject(
                    new Error(
                        `${command} completed successfully but emitted unexpected production runtime errors.${runtimeFailure}`
                    )
                );
                return;
            }
            resolve();
        });
    });
}
