-- Every application table is private to the Prisma server connection. The
-- Supabase Data API roles must never inherit direct table access, including
-- tables added between the original RLS hardening migration and today.
ALTER TABLE public."AnalysisJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BillingAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CreditLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."NotificationDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProviderSyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."StripeWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SyncJob" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."AnalysisJob" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisRun" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."BillingAccount" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."CreditLedgerEntry" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."Notification" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."NotificationDelivery" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."NotificationPreference" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."ProviderSyncState" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PushSubscription" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."StripeWebhookEvent" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."SyncJob" FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
REVOKE ALL ON TABLES FROM anon, authenticated;
