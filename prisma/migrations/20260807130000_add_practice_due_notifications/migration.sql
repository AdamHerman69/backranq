ALTER TYPE "NotificationType" ADD VALUE 'PRACTICE_DUE';

ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'QUEUED' BEFORE 'PROCESSING';

CREATE TYPE "PracticeDueSweepStatus" AS ENUM ('SCANNING', 'NOTIFYING', 'COMPLETE');

ALTER TABLE "NotificationDelivery"
ADD COLUMN "dispatchToken" UUID;

CREATE UNIQUE INDEX "NotificationDelivery_dispatchToken_key"
ON "NotificationDelivery"("dispatchToken");

DROP INDEX "NotificationDelivery_status_scheduledFor_idx";
CREATE INDEX "NotificationDelivery_status_scheduledFor_id_idx"
ON "NotificationDelivery"("status", "scheduledFor", "id");

DROP INDEX "NotificationDelivery_lockedUntil_idx";
CREATE INDEX "NotificationDelivery_status_lockedUntil_id_idx"
ON "NotificationDelivery"("status", "lockedUntil", "id");

DROP INDEX "PracticeReviewState_user_due_idx";
CREATE INDEX "PracticeReviewState_userId_nextDueAt_id_idx"
ON "PracticeReviewState"("userId", "nextDueAt", "id");

CREATE INDEX "PracticeReviewState_nextDueAt_id_idx"
ON "PracticeReviewState"("nextDueAt", "id");

-- Feed scans preserve lapse-first scheduling without sorting the user's full
-- inventory: each bucket is a separate nextDueAt/id keyset stream.
CREATE INDEX "PracticeReviewState_due_lapsed_scan_idx"
ON "PracticeReviewState"("userId", "nextDueAt", "id")
WHERE "lapses" > 0;

CREATE INDEX "PracticeReviewState_due_clean_scan_idx"
ON "PracticeReviewState"("userId", "nextDueAt", "id")
WHERE "lapses" = 0;

CREATE INDEX "TrainingMoment_new_practice_scan_idx"
ON "TrainingMoment"("userId", "createdAt", "id")
WHERE "status" = 'ACTIVE'
  AND "archivedAt" IS NULL
  AND "currentSolutionRevisionId" IS NOT NULL;

CREATE TABLE "PracticeDueSweep" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "referenceAt" TIMESTAMP(3) NOT NULL,
    "status" "PracticeDueSweepStatus" NOT NULL DEFAULT 'SCANNING',
    "cursorNextDueAt" TIMESTAMP(3),
    "cursorStateId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PracticeDueSweep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PracticeDueSweepUser" (
    "sweepId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dueCount" INTEGER NOT NULL,
    "dueCountIsExact" BOOLEAN NOT NULL DEFAULT true,
    "earliestDueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PracticeDueSweepUser_pkey" PRIMARY KEY ("sweepId", "userId")
);

CREATE UNIQUE INDEX "PracticeDueSweep_referenceAt_key"
ON "PracticeDueSweep"("referenceAt");
CREATE UNIQUE INDEX "PracticeDueSweep_single_active_key"
ON "PracticeDueSweep" ((1))
WHERE "status" IN ('SCANNING', 'NOTIFYING');
CREATE INDEX "PracticeDueSweep_status_completedAt_id_idx"
ON "PracticeDueSweep"("status", "completedAt", "id");
CREATE INDEX "PracticeDueSweepUser_userId_createdAt_idx"
ON "PracticeDueSweepUser"("userId", "createdAt");

ALTER TABLE "PracticeDueSweepUser"
ADD CONSTRAINT "PracticeDueSweepUser_sweepId_fkey"
FOREIGN KEY ("sweepId") REFERENCES "PracticeDueSweep"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeDueSweepUser"
ADD CONSTRAINT "PracticeDueSweepUser_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."PracticeDueSweep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeDueSweepUser" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeDueSweep" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeDueSweepUser" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."PracticeDueSweep" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PracticeDueSweepUser" FROM anon, authenticated;
