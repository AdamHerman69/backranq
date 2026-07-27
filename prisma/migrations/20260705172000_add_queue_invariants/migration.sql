-- Prevent duplicate active sync work for the same user/provider.
-- Historical completed/failed/cancelled rows remain available for observability.
WITH ranked_active_sync_jobs AS (
    SELECT
        "id",
        row_number() OVER (
            PARTITION BY "userId", "provider"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rank
    FROM "SyncJob"
    WHERE "status" IN ('QUEUED', 'RUNNING')
)
UPDATE "SyncJob"
SET
    "status" = 'FAILED',
    "completedAt" = now(),
    "lockedUntil" = NULL,
    "lastError" = 'Marked failed by queue invariant migration because another active job exists for this user/provider.'
WHERE "id" IN (
    SELECT "id"
    FROM ranked_active_sync_jobs
    WHERE rank > 1
);

CREATE UNIQUE INDEX "SyncJob_one_active_provider_job_idx"
ON "SyncJob"("userId", "provider")
WHERE "status" IN ('QUEUED', 'RUNNING');
