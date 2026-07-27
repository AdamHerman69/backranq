#!/usr/bin/env node
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed an auth session with NODE_ENV=production.');
    process.exit(1);
}

const appUrl = process.env.BACKRANQ_APP_URL ?? process.env.NEXTAUTH_URL ?? '';
if (appUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(appUrl)) {
    console.error(`Refusing to seed auth session for non-local app URL: ${appUrl}`);
    process.exit(1);
}

const email = process.argv[2] ?? 'stripe-smoke@backranq.local';
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

    console.log(
        JSON.stringify(
            {
                userId: user.id,
                email,
                sessionId: session.id,
                cookie: `authjs.session-token=${token}`,
                curlExample:
                    "curl -i -X POST http://localhost:3000/api/stripe/checkout -H 'Content-Type: application/json' -H 'Cookie: authjs.session-token=" +
                    token +
                    "' --data '{\"plan\":\"PLUS\"}'",
            },
            null,
            2
        )
    );
} finally {
    await prisma.$disconnect();
}
