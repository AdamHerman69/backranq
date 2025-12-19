import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export async function createSupabaseServerClient(): Promise<
    SupabaseClient<Database>
> {
    // Prefer NEXT_PUBLIC_* (works for both client + server), but also accept
    // the Supabase Vercel integration names to avoid env var duplication.
    const url =
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const anonKey =
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env.SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
        throw new Error(
            'Missing Supabase env vars: set NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY (recommended) or SUPABASE_URL/SUPABASE_ANON_KEY'
        );
    }

    const cookieStore = await cookies();

    return createServerClient<Database>(url, anonKey, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                for (const { name, value, options } of cookiesToSet) {
                    cookieStore.set(name, value, options);
                }
            },
        },
    });
}
