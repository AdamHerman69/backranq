-- The application reads and writes these tables through server-side Prisma
-- connections. Do not expose them directly through Supabase Data API roles.

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalyzedGame" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Puzzle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PuzzleAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."VerificationToken" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."User" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalyzedGame" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."Puzzle" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PuzzleAttempt" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."Account" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."Session" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."VerificationToken" FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL ON TABLES FROM anon, authenticated;
