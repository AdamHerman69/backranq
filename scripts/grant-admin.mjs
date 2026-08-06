#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    usage();
    process.exit(0);
}
if (
    args.invalid ||
    (Boolean(args.userId) === Boolean(args.email)) ||
    (args.userId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            args.userId
        )) ||
    (args.email &&
        (args.email.length > 320 ||
            !/^[^\s@]+@[^\s@]+$/.test(args.email))) ||
    (args.role !== 'EDITOR' && args.role !== 'ADMIN') ||
    args.confirm !== 'GRANT_ADMIN_ACCESS'
) {
    usage();
    process.exit(2);
}

const prisma = new PrismaClient();
try {
    const user = await prisma.user.findUnique({
        where: args.userId ? { id: args.userId } : { email: args.email },
        select: { id: true },
    });
    if (!user) {
        console.error('Refusing to grant access: the target user does not exist.');
        process.exitCode = 1;
    } else {
        const membership = await prisma.$transaction(async (tx) => {
            const granted = await tx.adminMembership.upsert({
                where: { userId: user.id },
                create: { userId: user.id, role: args.role, active: true },
                update: { role: args.role, active: true },
                select: { id: true, userId: true, role: true, active: true },
            });
            await tx.adminAuditLog.upsert({
                where: {
                    idempotencyKey: `admin-bootstrap:${user.id}:${args.role}`,
                },
                create: {
                    adminMembershipId: granted.id,
                    idempotencyKey: `admin-bootstrap:${user.id}:${args.role}`,
                    action: 'ADMIN_MEMBERSHIP_BOOTSTRAP',
                    targetType: 'AdminMembership',
                    targetId: granted.id,
                    reason: 'Explicit operator bootstrap',
                    metadata: { source: 'scripts/grant-admin.mjs' },
                },
                update: {},
            });
            return granted;
        });
        console.log(
            JSON.stringify(
                {
                    ok: true,
                    membershipId: membership.id,
                    userId: membership.userId,
                    role: membership.role,
                    active: membership.active,
                },
                null,
                2
            )
        );
    }
} finally {
    await prisma.$disconnect();
}

function parseArgs(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (key === '--') continue;
        if (key === '--help' || key === '-h') {
            parsed.help = true;
            continue;
        }
        if (
            key === '--user-id' ||
            key === '--email' ||
            key === '--role' ||
            key === '--confirm'
        ) {
            parsed[
                key === '--user-id' ? 'userId' : key.slice(2)
            ] = argv[index + 1];
            index += 1;
            continue;
        }
        console.error(`Unknown argument: ${key}`);
        parsed.invalid = true;
    }
    return parsed;
}

function usage() {
    console.error(
        [
            'Usage:',
            '  pnpm admin:grant -- --user-id <uuid> --role ADMIN --confirm GRANT_ADMIN_ACCESS',
            '  pnpm admin:grant -- --email <existing-email> --role EDITOR --confirm GRANT_ADMIN_ACCESS',
            '',
            'Exactly one existing user target is required. This script never creates a user.',
        ].join('\n')
    );
}
