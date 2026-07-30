ALTER FUNCTION public."enforce_training_moment_current_revision"()
SET search_path = public, pg_temp;

ALTER FUNCTION public."enforce_analyzed_game_current_run"()
SET search_path = public, pg_temp;

ALTER FUNCTION public."enforce_analysis_job_run"()
SET search_path = public, pg_temp;

ALTER FUNCTION public."enforce_training_observation_provenance"()
SET search_path = public, pg_temp;
