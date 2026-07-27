#!/usr/bin/env node
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

const checks = [
    required('DATABASE_URL'),
    required('DIRECT_URL'),
    required('NEXTAUTH_SECRET'),
    requiredOneOf(['BACKRANQ_APP_URL', 'NEXTAUTH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']),
    required('STRIPE_SECRET_KEY'),
    required('STRIPE_WEBHOOK_SECRET'),
    required('STRIPE_PRICE_PLUS_MONTHLY'),
    required('STRIPE_PRICE_PRO_MONTHLY'),
    requiredOneOf(['BACKRANQ_ADMIN_API_SECRET', 'ADMIN_API_SECRET']),
];

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
    console.log(`${check.ok ? 'ok ' : 'err'} ${check.label}`);
}

if (failures.length > 0) {
    console.error(`\nRuntime readiness failed: ${failures.length} missing setting(s).`);
    process.exit(1);
}

console.log('\nRuntime readiness passed.');

function required(name) {
    return { label: name, ok: Boolean(process.env[name]) };
}

function requiredOneOf(names) {
    return {
        label: names.join(' or '),
        ok: names.some((name) => Boolean(process.env[name])),
    };
}
