CREATE TYPE "EmailSendOwnerType" AS ENUM (
    'NOTIFICATION_DELIVERY',
    'PREMIUM_INVITATION'
);

CREATE TYPE "EmailSendReservationStatus" AS ENUM (
    'RESERVED',
    'HANDOFF',
    'SENT',
    'AMBIGUOUS',
    'RELEASED'
);

ALTER TABLE "PremiumInvitation"
ADD COLUMN "deliverySendAttemptId" UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "NotificationDelivery"
ADD COLUMN "dispatchPriority" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "NotificationDelivery"
ADD CONSTRAINT "NotificationDelivery_dispatchPriority_valid"
CHECK ("dispatchPriority" IN (0, 1));

-- Billing-action emails retain first access to the configured provider reserve.
UPDATE "NotificationDelivery" delivery
SET "dispatchPriority" = 0
FROM "Notification" notification
WHERE notification."id" = delivery."notificationId"
  AND delivery."channel" = 'EMAIL'::"NotificationChannel"
  AND notification."type" IN (
      'LOW_CREDITS'::"NotificationType",
      'BILLING_ACTION_REQUIRED'::"NotificationType"
  );

CREATE INDEX "NotificationDelivery_dispatch_stream_idx"
ON "NotificationDelivery"(
    "status",
    "channel",
    "dispatchPriority",
    "scheduledFor",
    "createdAt",
    "id"
);

CREATE INDEX "NotificationDelivery_pending_channel_schedule_idx"
ON "NotificationDelivery"(
    "status",
    "channel",
    "scheduledFor",
    "createdAt",
    "id"
);

CREATE INDEX "NotificationDelivery_active_lease_recovery_idx"
ON "NotificationDelivery"(
    "lockedUntil" ASC NULLS FIRST,
    "id"
)
WHERE "status" IN (
    'QUEUED'::"NotificationDeliveryStatus",
    'PROCESSING'::"NotificationDeliveryStatus"
);

CREATE TABLE "EmailProviderDay" (
    "day" DATE NOT NULL,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "nonPriorityReservedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailProviderDay_pkey" PRIMARY KEY ("day"),
    CONSTRAINT "EmailProviderDay_reservedCount_nonnegative"
        CHECK ("reservedCount" >= 0),
    CONSTRAINT "EmailProviderDay_nonPriorityReservedCount_nonnegative"
        CHECK ("nonPriorityReservedCount" >= 0),
    CONSTRAINT "EmailProviderDay_nonPriorityWithinTotal"
        CHECK ("nonPriorityReservedCount" <= "reservedCount")
);

CREATE TABLE "EmailSendReservation" (
    "id" UUID NOT NULL,
    "providerDay" DATE NOT NULL,
    "ownerType" "EmailSendOwnerType" NOT NULL,
    "ownerId" UUID NOT NULL,
    "ownerToken" UUID NOT NULL,
    "logicalAttemptKey" TEXT NOT NULL,
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "practiceWindowKey" TEXT,
    "status" "EmailSendReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSendReservation_ownerToken_key"
ON "EmailSendReservation"("ownerToken");
CREATE UNIQUE INDEX "EmailSendReservation_active_logicalAttemptKey_key"
ON "EmailSendReservation"("logicalAttemptKey")
WHERE "status" <> 'RELEASED'::"EmailSendReservationStatus";
CREATE UNIQUE INDEX "EmailSendReservation_practiceWindowKey_key"
ON "EmailSendReservation"("practiceWindowKey");
CREATE INDEX "EmailSendReservation_ownerType_ownerId_createdAt_idx"
ON "EmailSendReservation"("ownerType", "ownerId", "createdAt");
CREATE INDEX "EmailSendReservation_status_leaseUntil_id_idx"
ON "EmailSendReservation"("status", "leaseUntil", "id");

ALTER TABLE "EmailSendReservation"
ADD CONSTRAINT "EmailSendReservation_providerDay_fkey"
FOREIGN KEY ("providerDay") REFERENCES "EmailProviderDay"("day")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Provider budgets, ownership tokens and Practice send windows are exclusively
-- server-side delivery state and must never be exposed through the Data API.
ALTER TABLE public."EmailProviderDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EmailSendReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EmailProviderDay" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."EmailSendReservation" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."EmailProviderDay" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."EmailSendReservation" FROM anon, authenticated;
