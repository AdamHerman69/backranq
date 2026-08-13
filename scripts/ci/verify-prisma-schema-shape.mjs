#!/usr/bin/env node

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
    const columns = await prisma.$queryRawUnsafe(`
        SELECT table_name AS "tableName", column_name AS "columnName",
               is_nullable = 'YES' AS "nullable"
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
    `);

    const actual = new Map();
    for (const column of columns) {
        const table = actual.get(column.tableName) ?? new Map();
        table.set(column.columnName, column.nullable);
        actual.set(column.tableName, table);
    }
    actual.delete('_prisma_migrations');

    const expected = new Map();
    for (const model of Prisma.dmmf.datamodel.models) {
        const table = new Map();
        for (const field of model.fields) {
            if (field.kind === 'object') continue;
            table.set(field.dbName ?? field.name, !field.isRequired);
        }
        expected.set(model.dbName ?? model.name, table);
    }

    const errors = [];
    for (const tableName of union(expected.keys(), actual.keys())) {
        const expectedColumns = expected.get(tableName);
        const actualColumns = actual.get(tableName);
        if (!expectedColumns) {
            errors.push(`unexpected database table public.${tableName}`);
            continue;
        }
        if (!actualColumns) {
            errors.push(`missing database table public.${tableName}`);
            continue;
        }
        for (const columnName of union(expectedColumns.keys(), actualColumns.keys())) {
            if (!expectedColumns.has(columnName)) {
                errors.push(`unexpected column public.${tableName}.${columnName}`);
                continue;
            }
            if (!actualColumns.has(columnName)) {
                errors.push(`missing column public.${tableName}.${columnName}`);
                continue;
            }
            if (expectedColumns.get(columnName) !== actualColumns.get(columnName)) {
                errors.push(
                    `nullability mismatch public.${tableName}.${columnName}: Prisma=${expectedColumns.get(columnName) ? 'nullable' : 'required'}, database=${actualColumns.get(columnName) ? 'nullable' : 'required'}`
                );
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(`Prisma/database schema shape drift:\n- ${errors.join('\n- ')}`);
    }

    console.log(
        `Prisma schema shape matches ${expected.size} database tables (${columns.length} columns inspected).`
    );
} finally {
    await prisma.$disconnect();
}

function union(left, right) {
    return [...new Set([...left, ...right])].sort();
}
