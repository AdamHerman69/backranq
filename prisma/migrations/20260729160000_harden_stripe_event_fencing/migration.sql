ALTER TABLE "BillingAccount"
ADD COLUMN "stripeLastEventCreatedAt" TIMESTAMP(3),
ADD COLUMN "stripeLastEventId" TEXT;

ALTER TABLE "StripeWebhookEvent"
ADD COLUMN "processingToken" TEXT,
ADD COLUMN "processingUntil" TIMESTAMP(3);

CREATE INDEX "StripeWebhookEvent_status_processingUntil_idx"
ON "StripeWebhookEvent"("status", "processingUntil");
