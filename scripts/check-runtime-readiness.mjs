#!/usr/bin/env node
import fs from 'node:fs';

import { loadEnvFiles } from './lib/load-env.mjs';
import {
    evaluateDeploymentReadiness,
    readVercelReadinessConfiguration,
} from '../src/lib/config/deploymentReadinessCore.ts';

const args = new Set(process.argv.slice(2));
if (!args.has('--no-env-files')) loadEnvFiles();

const vercelConfiguration = JSON.parse(
    fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
);
const readiness = evaluateDeploymentReadiness({
    env: process.env,
    profile: args.has('--local') ? 'local' : 'production',
    expectedQueueTopic: 'backranq-jobs',
    vercel: readVercelReadinessConfiguration(vercelConfiguration),
});

if (args.has('--json')) {
    console.log(JSON.stringify(readiness));
} else {
    for (const check of readiness.checks) {
        const details = [...check.missing, ...check.warnings];
        console.log(
            `${check.ok ? 'ok ' : 'err'} ${check.group}${details.length > 0 ? `: ${details.join('; ')}` : ''}`
        );
    }
}

if (!readiness.ok) {
    if (!args.has('--json')) console.error('\nRuntime readiness failed.');
    process.exit(1);
}

if (!args.has('--json')) console.log('\nRuntime readiness passed.');
