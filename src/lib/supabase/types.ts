export type Json =
    | string
    | number
    | boolean
    | null
    | { [key: string]: Json | undefined }
    | Json[];

/**
 * Starter Supabase `Database` type.
 *
 * Replace with generated types when you add tables, e.g.
 * `supabase gen types typescript --project-id ...`
 */
export type Database = {
    public: {
        Tables: Record<string, never>;
        Views: Record<string, never>;
        Functions: Record<string, never>;
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
};
