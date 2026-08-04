CREATE TYPE "NotificationType" AS ENUM (
    'PRACTICE_READY',
    'NEW_GAMES_SYNCED',
    'ANALYSIS_FAILED',
    'SYNC_FAILED',
    'LOW_CREDITS',
    'BILLING_ACTION_REQUIRED',
    'WELCOME',
    'WEEKLY_PROGRESS',
    'PRODUCT_NEWS'
);

CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WEB_PUSH');

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'DELIVERED',
    'FAILED',
    'BOUNCED',
    'COMPLAINED',
    'SUPPRESSED',
    'CANCELLED'
);

CREATE TYPE "NotificationDigestFrequency" AS ENUM ('OFF', 'DAILY', 'WEEKLY');

CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emailPracticeReady" BOOLEAN NOT NULL DEFAULT true,
    "emailAnalysisFailed" BOOLEAN NOT NULL DEFAULT false,
    "emailSyncSummary" BOOLEAN NOT NULL DEFAULT false,
    "emailBilling" BOOLEAN NOT NULL DEFAULT true,
    "emailWeeklyProgress" BOOLEAN NOT NULL DEFAULT false,
    "emailProductNews" BOOLEAN NOT NULL DEFAULT false,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncDigestFrequency" "NotificationDigestFrequency" NOT NULL DEFAULT 'OFF',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "digestHour" INTEGER NOT NULL DEFAULT 9,
    "productNewsConsentedAt" TIMESTAMP(3),
    "optionalEmailsUnsubscribedAt" TIMESTAMP(3),
    "emailSuppressedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "itemCount" INTEGER NOT NULL DEFAULT 1,
    "secondaryCount" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");
CREATE INDEX "NotificationPreference_emailWeeklyProgress_timezone_digestHour_idx" ON "NotificationPreference"("emailWeeklyProgress", "timezone", "digestHour");
CREATE INDEX "NotificationPreference_emailProductNews_productNewsConsentedAt_idx" ON "NotificationPreference"("emailProductNews", "productNewsConsentedAt");
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
CREATE INDEX "Notification_userId_type_createdAt_idx" ON "Notification"("userId", "type", "createdAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE UNIQUE INDEX "NotificationDelivery_providerMessageId_key" ON "NotificationDelivery"("providerMessageId");
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId", "channel");
CREATE INDEX "NotificationDelivery_status_scheduledFor_idx" ON "NotificationDelivery"("status", "scheduledFor");
CREATE INDEX "NotificationDelivery_userId_channel_createdAt_idx" ON "NotificationDelivery"("userId", "channel", "createdAt");
CREATE INDEX "NotificationDelivery_lockedUntil_idx" ON "NotificationDelivery"("lockedUntil");
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
