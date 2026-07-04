-- Prisma creates this table while establishing migration history. Keep it out
-- of Supabase Data API access just like application-owned tables.

ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM anon, authenticated;
