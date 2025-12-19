import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export function createSupabaseBrowserClient(): SupabaseClient<Database> {
    // Prefer NEXT_PUBLIC_* (required for client-side access), but also accept
    // Supabase Vercel integration names so local/SSR code can share config.
    //
    // Note: in production you should still set NEXT_PUBLIC_* so the client bundle
    // receives the values at build time.
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

    return createBrowserClient<Database>(url, anonKey);
}
