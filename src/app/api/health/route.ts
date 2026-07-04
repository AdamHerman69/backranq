import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
    const databaseUrl = process.env.DATABASE_URL;
    const url =
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const anonKey =
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env.SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const missingSupabase = [
        ...(url ? [] : ['NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL']),
        ...(anonKey
            ? []
            : ['NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY']),
    ];

    if (!databaseUrl && missingSupabase.length > 0) {
        return NextResponse.json(
            {
                ok: false,
                error: 'Missing database and Supabase environment variables',
                database: { configured: false },
                supabase: {
                    configured: false,
                    missing: missingSupabase,
                },
            },
            { status: 500 }
        );
    }

    const database = databaseUrl
        ? await checkDatabase()
        : { configured: false as const };
    const supabase =
        url && anonKey
            ? await checkSupabaseRest(
                  url,
                  serviceKey ?? anonKey,
                  serviceKey ? 'service_role' : 'anon'
              )
            : {
                  configured: false as const,
                  missing: missingSupabase,
              };

    const configuredChecks = [database, supabase].filter(
        (x) => x.configured && 'ok' in x
    );
    const configComplete = Boolean(databaseUrl) && missingSupabase.length === 0;
    const ok =
        configComplete &&
        configuredChecks.every((x) => 'ok' in x && x.ok);

    return NextResponse.json(
        {
            ok,
            configComplete,
            database,
            supabase,
        },
        { status: ok ? 200 : configComplete ? 503 : 500 }
    );
}

async function checkDatabase() {
    const startedAt = Date.now();
    try {
        await prisma.$queryRaw`SELECT 1`;

        return {
            configured: true as const,
            ok: true,
            reachable: true,
            latencyMs: Date.now() - startedAt,
        };
    } catch (err) {
        return {
            configured: true as const,
            ok: false,
            reachable: false,
            latencyMs: Date.now() - startedAt,
            error:
                err instanceof Error
                    ? err.message
                    : 'Unknown error contacting database',
        };
    }
}

async function checkSupabaseRest(
    url: string,
    key: string,
    keyKind: 'anon' | 'service_role'
) {
    const baseUrl = url.replace(/\/+$/, '');
    const startedAt = Date.now();
    try {
        // This hits PostgREST (the DB API). We don't assume any tables exist yet.
        const res = await fetch(`${baseUrl}/rest/v1/`, {
            method: 'GET',
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
            },
            cache: 'no-store',
        });

        const latencyMs = Date.now() - startedAt;

        return {
            configured: true as const,
            ok: res.ok,
            reachable: true,
            authorized: res.ok,
            status: res.status,
            latencyMs,
            used: keyKind,
        };
    } catch (err) {
        const latencyMs = Date.now() - startedAt;
        return {
            configured: true as const,
            ok: false,
            reachable: false,
            latencyMs,
            error:
                err instanceof Error
                    ? err.message
                    : 'Unknown error contacting Supabase',
        };
    }
}
