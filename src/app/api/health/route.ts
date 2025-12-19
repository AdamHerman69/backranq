import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
    const url =
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const anonKey =
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env.SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !anonKey) {
        return NextResponse.json(
            {
                ok: false,
                error: 'Missing Supabase environment variables',
                missing: [
                    ...(url
                        ? []
                        : ['NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL']),
                    ...(anonKey
                        ? []
                        : [
                              'NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY',
                          ]),
                ],
            },
            { status: 500 }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const key: string = serviceKey ?? anonKey;

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

        return NextResponse.json(
            {
                ok: res.ok,
                reachable: true,
                authorized: res.ok,
                status: res.status,
                latencyMs,
                used: serviceKey ? 'service_role' : 'anon',
            },
            { status: 200 }
        );
    } catch (err) {
        const latencyMs = Date.now() - startedAt;
        return NextResponse.json(
            {
                ok: false,
                reachable: false,
                latencyMs,
                error:
                    err instanceof Error
                        ? err.message
                        : 'Unknown error contacting Supabase',
            },
            { status: 503 }
        );
    }
}
