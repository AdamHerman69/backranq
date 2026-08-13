-- `prisma migrate diff --from-migrations` replays SQL into a shadow schema
-- without creating Prisma's internal history table first. A later historical
-- hardening migration revokes Data API access from that table, so create the
-- minimal reserved relation when replaying. In a normal Prisma deployment the
-- complete internal table already exists and this is a no-op.
CREATE TABLE IF NOT EXISTS public._prisma_migrations (
    id VARCHAR(36) PRIMARY KEY
);
