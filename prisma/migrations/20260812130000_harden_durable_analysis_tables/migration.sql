-- Durable analysis orchestration is private server-side state. Keep it out of
-- the Supabase Data API even if public-schema defaults change later.
ALTER TABLE public."AnalysisBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisBatchItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisRunCheckpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisMaintenanceLease" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."AnalysisBatch" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisBatchItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisOutbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisRunCheckpoint" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisMaintenanceLease" FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."AnalysisBatch" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisBatchItem" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisOutbox" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisRunCheckpoint" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisMaintenanceLease" FROM anon, authenticated;

-- The trigger only inspects OLD/NEW records, so it does not need a caller-
-- controlled schema lookup path or public execution privileges.
ALTER FUNCTION public."enforce_analysis_checkpoint_monotonic_version"()
SET search_path = pg_catalog;
REVOKE ALL PRIVILEGES ON FUNCTION public."enforce_analysis_checkpoint_monotonic_version"()
FROM PUBLIC, anon, authenticated;

-- Cover the composite batch ownership foreign key for cascades and validation.
CREATE INDEX "AnalysisBatchItem_batchId_userId_idx"
ON public."AnalysisBatchItem"("batchId", "userId");
