#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnvFiles } from './lib/load-env.mjs';
import { assertSafeLocalAuthSeedConfig } from './lib/local-database-safety.mjs';
import { writePrivateLocalJson } from './lib/private-local-file.mjs';

loadEnvFiles();

const appUrl = process.env.BACKRANQ_APP_URL ?? process.env.NEXTAUTH_URL ?? '';
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const email = positional[0] ?? 'stripe-smoke@backranq.local';
const printCookie = process.argv.includes('--print-cookie');
const safety = assertSafeLocalAuthSeedConfig({
    environment: process.env,
    appUrl,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    email,
});
const token = crypto.randomBytes(32).toString('hex');
const prisma = new PrismaClient();

try {
    const user = await prisma.user.upsert({
        where: { email },
        update: {},
        create: {
            email,
            name: 'Stripe Smoke User',
            preferences: {},
        },
    });
    const session = await prisma.session.create({
        data: {
            sessionToken: token,
            userId: user.id,
            expires: new Date(Date.now() + 60 * 60 * 1_000),
        },
    });

    const outputDirectory = path.join(process.cwd(), '.backranq-local');
    const outputPath = writePrivateLocalJson(
        outputDirectory,
        'auth-session.json',
        {
            userId: user.id,
            email,
            sessionId: session.id,
            cookie: `authjs.session-token=${token}`,
            expires: session.expires.toISOString(),
        }
    );
    console.log(`Created local auth session in ${safety.databaseFingerprint}.`);
    console.log(`Credentials were written with owner-only permissions to ${outputPath}.`);
    if (printCookie) console.log(`authjs.session-token=${token}`);
} finally {
    await prisma.$disconnect();
}
