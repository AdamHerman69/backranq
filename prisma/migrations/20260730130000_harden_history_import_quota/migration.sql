-- History import quotas are application-owned state accessed only through
-- server-side Prisma connections. Keep the table out of Supabase Data API
-- access, matching every other private application table.

ALTER TABLE public."HistoryImportQuota" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."HistoryImportQuota"
FROM anon, authenticated;
