#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const roles = ['anon', 'authenticated'];
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
// Prisma owns and mutates this implementation table while discovering and
// applying migrations. It is not an application model and may be created after
// migration SQL starts running, so the dynamic application-table contract below
// intentionally excludes it. Its Data API isolation is verified separately:
// no anon/authenticated grants are allowed, regardless of Prisma's RLS state.
const prismaInternalTables = new Set(['_prisma_migrations']);

try {
    const tables = await prisma.$queryRawUnsafe(`
        SELECT
            c.oid::int AS oid,
            c.relname AS name,
            c.relrowsecurity AS "rowSecurity",
            a.attname AS "firstColumn"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL (
            SELECT attname
            FROM pg_attribute
            WHERE attrelid = c.oid
              AND attnum > 0
              AND NOT attisdropped
            ORDER BY attnum
            LIMIT 1
        ) a ON TRUE
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
        ORDER BY c.relname
    `);

    const applicationTables = tables.filter(
        (table) => !prismaInternalTables.has(table.name)
    );
    const internalTables = tables.filter((table) =>
        prismaInternalTables.has(table.name)
    );

    if (applicationTables.length === 0) {
        throw new Error('Database contract check found no public application tables.');
    }

    for (const table of applicationTables) {
        if (!table.rowSecurity) {
            throw new Error(`RLS is disabled on public.${table.name}.`);
        }

        for (const role of roles) {
            for (const privilege of privileges) {
                const rows = await prisma.$queryRawUnsafe(
                    `SELECT has_table_privilege($1, $2::oid, $3) AS allowed`,
                    role,
                    table.oid,
                    privilege
                );
                if (rows[0]?.allowed) {
                    throw new Error(
                        `${role} unexpectedly has ${privilege} on public.${table.name}.`
                    );
                }
            }

            await expectPermissionDenied(
                role,
                `SELECT * FROM ${qualified(table.name)} LIMIT 1`,
                `${role} SELECT public.${table.name}`
            );
            await expectPermissionDenied(
                role,
                `INSERT INTO ${qualified(table.name)} DEFAULT VALUES`,
                `${role} INSERT public.${table.name}`
            );
            await expectPermissionDenied(
                role,
                `UPDATE ${qualified(table.name)} SET ${identifier(table.firstColumn)} = ${identifier(table.firstColumn)} WHERE FALSE`,
                `${role} UPDATE public.${table.name}`
            );
            await expectPermissionDenied(
                role,
                `DELETE FROM ${qualified(table.name)} WHERE FALSE`,
                `${role} DELETE public.${table.name}`
            );
        }
    }

    for (const table of internalTables) {
        await verifyNoRolePrivileges(table);
    }

    const policies = await prisma.$queryRawUnsafe(`
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
    `);
    if (policies.length > 0) {
        throw new Error(
            `Private Prisma tables must not expose RLS policies: ${policies
                .map((policy) => `${policy.tablename}.${policy.policyname}`)
                .join(', ')}`
        );
    }

    await prisma.user.count();
    console.log(
        `Database contract passed for ${applicationTables.length} application tables, ${internalTables.length} Prisma internal table, and ${roles.length} untrusted roles.`
    );
} finally {
    await prisma.$disconnect();
}

async function verifyNoRolePrivileges(table) {
    for (const role of roles) {
        for (const privilege of privileges) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT has_table_privilege($1, $2::oid, $3) AS allowed`,
                role,
                table.oid,
                privilege
            );
            if (rows[0]?.allowed) {
                throw new Error(
                    `${role} unexpectedly has ${privilege} on Prisma internal table public.${table.name}.`
                );
            }
        }
    }
}

async function expectPermissionDenied(role, sql, label) {
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${identifier(role)}`);
            if (/^SELECT\b/i.test(sql)) await tx.$queryRawUnsafe(sql);
            else await tx.$executeRawUnsafe(sql);
        });
    } catch (error) {
        const serialized = `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(error)}`;
        if (serialized.includes('42501') || /permission denied/i.test(serialized)) {
            return;
        }
        throw new Error(`${label} failed for an unexpected reason: ${serialized}`);
    }
    throw new Error(`${label} unexpectedly succeeded.`);
}

function identifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function qualified(table) {
    return `public.${identifier(table)}`;
}
