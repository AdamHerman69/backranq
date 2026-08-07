CREATE TYPE "AdminRole" AS ENUM ('EDITOR', 'ADMIN');
CREATE TYPE "MasterPipelineStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "MasterPipelineStage" AS ENUM ('SOURCE', 'ANALYSIS', 'RANKING', 'PUBLICATION', 'COMPLETE');
CREATE TYPE "MasterPipelineTrigger" AS ENUM ('SCHEDULED', 'ADMIN', 'RETRY', 'RECOVERY');
CREATE TYPE "MasterSourceAvailability" AS ENUM ('AVAILABLE', 'MISSING', 'ERROR');
CREATE TYPE "MasterCandidateStatus" AS ENUM ('ELIGIBLE', 'REJECTED', 'PUBLISHED');
CREATE TYPE "MasterPublicationStatus" AS ENUM ('PUBLISHED', 'WITHDRAWN');
CREATE TYPE "MasterPublicationHealth" AS ENUM ('FRESH', 'STALE', 'SOURCE_MISSING', 'BLOCKED');
CREATE TYPE "MasterOverrideKind" AS ENUM ('PIN_PUBLICATION', 'FORCE_FALLBACK', 'PAUSE_AUTOMATION', 'EXCLUDE_PERSON', 'EXCLUDE_ACCOUNT', 'WITHDRAW_PUBLICATION');
CREATE TYPE "OnboardingEventName" AS ENUM ('LANDING_VIEWED', 'IDENTITY_SUBMITTED', 'IDENTITY_LOOKUP_SUCCEEDED', 'IDENTITY_LOOKUP_FAILED', 'PERSONAL_ANALYSIS_STARTED', 'PERSONAL_ANALYSIS_FAILED', 'PERSONAL_ANALYSIS_MILESTONE', 'PERSONAL_PUZZLE_READY', 'MASTER_PUZZLE_SHOWN', 'MASTER_ATTEMPT_STARTED', 'MASTER_ATTEMPT_TERMINAL', 'PERSONAL_READY_NOTICE_SHOWN', 'PERSONAL_HANDOFF_CLICKED', 'PERSONAL_PUZZLE_SHOWN', 'PERSONAL_ATTEMPT_STARTED', 'PERSONAL_ATTEMPT_TERMINAL', 'SIGNUP_CLICKED', 'SIGNUP_COMPLETED');
CREATE TYPE "OnboardingPuzzleKind" AS ENUM ('MASTER', 'PERSONAL');
CREATE TYPE "OnboardingMasterState" AS ENUM ('SOLVING', 'TERMINAL');

CREATE TABLE "AdminMembership" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'EDITOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditLog" (
    "id" UUID NOT NULL,
    "adminMembershipId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "requestId" TEXT,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnboardingAnalyticsEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "onboardingRunId" UUID,
    "userId" UUID,
    "eventName" "OnboardingEventName" NOT NULL,
    "provider" "Provider",
    "puzzleKind" "OnboardingPuzzleKind",
    "experimentKey" TEXT,
    "variantKey" TEXT,
    "durationMs" INTEGER,
    "gameCount" INTEGER,
    "gameIndex" INTEGER,
    "progressMilestone" INTEGER,
    "reason" TEXT,
    "masterState" "OnboardingMasterState",
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingAnalyticsEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OnboardingAnalyticsEvent_bounded_values" CHECK (
        ("durationMs" IS NULL OR "durationMs" BETWEEN 0 AND 86400000) AND
        ("gameCount" IS NULL OR "gameCount" BETWEEN 0 AND 500) AND
        ("gameIndex" IS NULL OR "gameIndex" BETWEEN 0 AND 499) AND
        ("progressMilestone" IS NULL OR "progressMilestone" IN (25, 50, 75, 100)) AND
        ("experimentKey" IS NULL OR char_length("experimentKey") BETWEEN 1 AND 64) AND
        ("variantKey" IS NULL OR char_length("variantKey") BETWEEN 1 AND 64) AND
        ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 64) AND
        char_length("eventId") BETWEEN 1 AND 128
    )
);

CREATE TABLE "OnboardingRateBucket" (
    "keyHash" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnboardingRateBucket_pkey" PRIMARY KEY ("keyHash", "namespace"),
    CONSTRAINT "OnboardingRateBucket_request_count" CHECK ("requestCount" BETWEEN 0 AND 1000),
    CONSTRAINT "OnboardingRateBucket_key_lengths" CHECK (char_length("keyHash") BETWEEN 32 AND 128 AND char_length("namespace") BETWEEN 1 AND 64)
);

CREATE TABLE "MasterPerson" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "attributionLabel" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterPerson_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MasterAccount" (
    "id" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "username" TEXT NOT NULL,
    "usernameNormalized" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "identityEvidence" JSONB NOT NULL DEFAULT '{}',
    "identityVerifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastFetchAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextFetchAt" TIMESTAMP(3),
    "etag" TEXT,
    "lastModified" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterAccount_failures_nonnegative" CHECK ("consecutiveFailures" >= 0)
);

CREATE TABLE "MasterPipelineRun" (
    "id" UUID NOT NULL,
    "runKey" TEXT NOT NULL,
    "status" "MasterPipelineStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "MasterPipelineStage" NOT NULL DEFAULT 'SOURCE',
    "trigger" "MasterPipelineTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "configSnapshot" JSONB NOT NULL DEFAULT '{}',
    "configHash" TEXT NOT NULL,
    "fetchedGames" INTEGER NOT NULL DEFAULT 0,
    "createdSnapshots" INTEGER NOT NULL DEFAULT 0,
    "analyzedSnapshots" INTEGER NOT NULL DEFAULT 0,
    "eligibleCandidates" INTEGER NOT NULL DEFAULT 0,
    "publishedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterPipelineRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterPipelineRun_counters_nonnegative" CHECK (
        "attempts" >= 0 AND "fetchedGames" >= 0 AND "createdSnapshots" >= 0 AND
        "analyzedSnapshots" >= 0 AND "eligibleCandidates" >= 0 AND "publishedCount" >= 0
    )
);

CREATE TABLE "MasterSourceGame" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "availability" "MasterSourceAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "currentSnapshotId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSince" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterSourceGame_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MasterSourceGameDiscovery" (
    "sourceGameId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "featuredSide" "GameUserSide" NOT NULL DEFAULT 'UNKNOWN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterSourceGameDiscovery_pkey" PRIMARY KEY ("sourceGameId", "accountId")
);

CREATE TABLE "MasterSourceGameSnapshot" (
    "id" UUID NOT NULL,
    "sourceGameId" UUID NOT NULL,
    "pipelineRunId" UUID,
    "snapshotHash" TEXT NOT NULL,
    "pgnHash" TEXT NOT NULL,
    "pgn" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "playedAt" TIMESTAMP(3) NOT NULL,
    "timeClass" "TimeClass" NOT NULL,
    "timeControlRaw" TEXT,
    "timeControlInitialSeconds" INTEGER,
    "timeControlIncrementSeconds" INTEGER,
    "rated" BOOLEAN,
    "result" TEXT,
    "termination" TEXT,
    "whiteName" TEXT NOT NULL,
    "whiteRating" INTEGER,
    "blackName" TEXT NOT NULL,
    "blackRating" INTEGER,
    "providerMetadata" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterSourceGameSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterSourceGameSnapshot_time_control_nonnegative" CHECK (
        ("timeControlInitialSeconds" IS NULL OR "timeControlInitialSeconds" >= 0) AND
        ("timeControlIncrementSeconds" IS NULL OR "timeControlIncrementSeconds" >= 0)
    )
);

CREATE TABLE "MasterAnalysisReceipt" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "pipelineRunId" UUID NOT NULL,
    "configHash" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterAnalysisReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterAnalysisReceipt_candidate_count_nonnegative" CHECK ("candidateCount" >= 0)
);

CREATE TABLE "MasterCandidate" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "pipelineRunId" UUID NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "decisionPly" INTEGER NOT NULL,
    "fen" TEXT NOT NULL,
    "positionHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sideToMove" TEXT NOT NULL,
    "originalMoveUci" TEXT NOT NULL,
    "scoreBefore" JSONB NOT NULL,
    "scoreAfter" JSONB NOT NULL,
    "cpLoss" DOUBLE PRECISION,
    "winChanceLoss" DOUBLE PRECISION,
    "phase" "GamePhase",
    "sourceKinds" "TrainingSourceKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingSourceKind"[],
    "lessonKinds" "TrainingLessonKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingLessonKind"[],
    "themes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "verificationStatus" "VerificationStatus" NOT NULL,
    "solutionShape" "SolutionShape" NOT NULL,
    "gradingStrategy" "GradingStrategy" NOT NULL,
    "continuationShape" "ContinuationShape" NOT NULL,
    "bestMoveUci" TEXT NOT NULL,
    "acceptedMovesUci" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "bestLine" JSONB NOT NULL,
    "solutionTree" JSONB NOT NULL DEFAULT '{}',
    "moveAssessments" JSONB NOT NULL DEFAULT '[]',
    "scoreAtStart" JSONB,
    "playedMoveScore" JSONB,
    "targetOutcome" JSONB NOT NULL DEFAULT '{}',
    "gradingPolicy" JSONB NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "solutionHash" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "hardGatePassed" BOOLEAN NOT NULL,
    "rejectionReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "freshnessScore" DOUBLE PRECISION NOT NULL,
    "recognitionScore" DOUBLE PRECISION NOT NULL,
    "clarityScore" DOUBLE PRECISION NOT NULL,
    "engineConfidenceScore" DOUBLE PRECISION NOT NULL,
    "humanInterestScore" DOUBLE PRECISION NOT NULL,
    "solutionLengthScore" DOUBLE PRECISION NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL,
    "status" "MasterCandidateStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterCandidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterCandidate_decision_ply_nonnegative" CHECK ("decisionPly" >= 0),
    CONSTRAINT "MasterCandidate_scores_finite_range" CHECK (
        "freshnessScore" BETWEEN 0 AND 1 AND "recognitionScore" BETWEEN 0 AND 1 AND
        "clarityScore" BETWEEN 0 AND 1 AND "engineConfidenceScore" BETWEEN 0 AND 1 AND
        "humanInterestScore" BETWEEN 0 AND 1 AND "solutionLengthScore" BETWEEN 0 AND 1 AND
        "totalScore" BETWEEN 0 AND 100
    )
);

CREATE TABLE "MasterPublication" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "candidateId" UUID NOT NULL,
    "status" "MasterPublicationStatus" NOT NULL DEFAULT 'PUBLISHED',
    "health" "MasterPublicationHealth" NOT NULL DEFAULT 'FRESH',
    "headline" TEXT NOT NULL,
    "teaser" TEXT NOT NULL,
    "attributionLabel" TEXT NOT NULL,
    "promptPayload" JSONB NOT NULL,
    "reviewPayload" JSONB NOT NULL,
    "sourceUrl" TEXT,
    "contentHash" TEXT NOT NULL,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "staleSince" TIMESTAMP(3),
    "healthReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterPublication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MasterSlot" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "currentPublicationId" UUID,
    "fallbackPublicationId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MasterSlot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterSlot_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "MasterAdminOverride" (
    "id" UUID NOT NULL,
    "kind" "MasterOverrideKind" NOT NULL,
    "slotId" UUID,
    "personId" UUID,
    "accountId" UUID,
    "publicationId" UUID,
    "targetPublicationId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByAdminId" UUID NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByAdminId" UUID,
    "revokeReason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterAdminOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MasterAdminOverride_valid_window" CHECK ("expiresAt" > "startsAt"),
    CONSTRAINT "MasterAdminOverride_scope" CHECK (
        ("kind" = 'PIN_PUBLICATION' AND "slotId" IS NOT NULL AND "targetPublicationId" IS NOT NULL AND "personId" IS NULL AND "accountId" IS NULL AND "publicationId" IS NULL) OR
        ("kind" IN ('FORCE_FALLBACK', 'PAUSE_AUTOMATION') AND "slotId" IS NOT NULL AND "targetPublicationId" IS NULL AND "personId" IS NULL AND "accountId" IS NULL AND "publicationId" IS NULL) OR
        ("kind" = 'EXCLUDE_PERSON' AND "personId" IS NOT NULL AND "slotId" IS NULL AND "accountId" IS NULL AND "publicationId" IS NULL AND "targetPublicationId" IS NULL) OR
        ("kind" = 'EXCLUDE_ACCOUNT' AND "accountId" IS NOT NULL AND "slotId" IS NULL AND "personId" IS NULL AND "publicationId" IS NULL AND "targetPublicationId" IS NULL) OR
        ("kind" = 'WITHDRAW_PUBLICATION' AND "publicationId" IS NOT NULL AND "slotId" IS NULL AND "personId" IS NULL AND "accountId" IS NULL AND "targetPublicationId" IS NULL)
    )
);

CREATE UNIQUE INDEX "AdminMembership_userId_key" ON "AdminMembership"("userId");
CREATE INDEX "AdminMembership_active_role_idx" ON "AdminMembership"("active", "role");
CREATE UNIQUE INDEX "AdminAuditLog_idempotencyKey_key" ON "AdminAuditLog"("idempotencyKey");
CREATE INDEX "AdminAuditLog_adminMembershipId_createdAt_idx" ON "AdminAuditLog"("adminMembershipId", "createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_createdAt_idx" ON "AdminAuditLog"("targetType", "targetId", "createdAt");
CREATE INDEX "AdminAuditLog_requestId_idx" ON "AdminAuditLog"("requestId");
CREATE UNIQUE INDEX "OnboardingAnalyticsEvent_sessionId_eventId_key" ON "OnboardingAnalyticsEvent"("sessionId", "eventId");
CREATE INDEX "OnboardingAnalyticsEvent_eventName_occurredAt_idx" ON "OnboardingAnalyticsEvent"("eventName", "occurredAt");
CREATE INDEX "OnboardingAnalyticsEvent_sessionId_occurredAt_idx" ON "OnboardingAnalyticsEvent"("sessionId", "occurredAt");
CREATE INDEX "OnboardingAnalyticsEvent_onboardingRunId_occurredAt_idx" ON "OnboardingAnalyticsEvent"("onboardingRunId", "occurredAt");
CREATE INDEX "OnboardingAnalyticsEvent_userId_occurredAt_idx" ON "OnboardingAnalyticsEvent"("userId", "occurredAt");
CREATE INDEX "OnboardingRateBucket_windowStartedAt_idx" ON "OnboardingRateBucket"("windowStartedAt");
CREATE UNIQUE INDEX "MasterPerson_slug_key" ON "MasterPerson"("slug");
CREATE INDEX "MasterPerson_active_priority_idx" ON "MasterPerson"("active", "priority");
CREATE UNIQUE INDEX "MasterAccount_provider_usernameNormalized_key" ON "MasterAccount"("provider", "usernameNormalized");
CREATE INDEX "MasterAccount_active_nextFetchAt_priority_idx" ON "MasterAccount"("active", "nextFetchAt", "priority");
CREATE INDEX "MasterAccount_personId_active_idx" ON "MasterAccount"("personId", "active");
CREATE UNIQUE INDEX "MasterPipelineRun_runKey_key" ON "MasterPipelineRun"("runKey");
CREATE UNIQUE INDEX "MasterPipelineRun_one_active_idx" ON "MasterPipelineRun" ((true)) WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE INDEX "MasterPipelineRun_status_scheduledFor_idx" ON "MasterPipelineRun"("status", "scheduledFor");
CREATE INDEX "MasterPipelineRun_lockedUntil_idx" ON "MasterPipelineRun"("lockedUntil");
CREATE INDEX "MasterPipelineRun_createdAt_idx" ON "MasterPipelineRun"("createdAt");
CREATE UNIQUE INDEX "MasterSourceGame_provider_externalId_key" ON "MasterSourceGame"("provider", "externalId");
CREATE UNIQUE INDEX "MasterSourceGame_currentSnapshotId_key" ON "MasterSourceGame"("currentSnapshotId");
CREATE INDEX "MasterSourceGame_availability_lastCheckedAt_idx" ON "MasterSourceGame"("availability", "lastCheckedAt");
CREATE INDEX "MasterSourceGameDiscovery_accountId_lastSeenAt_idx" ON "MasterSourceGameDiscovery"("accountId", "lastSeenAt");
CREATE UNIQUE INDEX "MasterSourceGameSnapshot_sourceGameId_snapshotHash_key" ON "MasterSourceGameSnapshot"("sourceGameId", "snapshotHash");
CREATE INDEX "MasterSourceGameSnapshot_sourceGameId_fetchedAt_idx" ON "MasterSourceGameSnapshot"("sourceGameId", "fetchedAt");
CREATE INDEX "MasterSourceGameSnapshot_pgnHash_idx" ON "MasterSourceGameSnapshot"("pgnHash");
CREATE UNIQUE INDEX "MasterAnalysisReceipt_snapshotId_accountId_configHash_key" ON "MasterAnalysisReceipt"("snapshotId", "accountId", "configHash");
CREATE INDEX "MasterAnalysisReceipt_pipelineRunId_complete_idx" ON "MasterAnalysisReceipt"("pipelineRunId", "complete");
CREATE INDEX "MasterAnalysisReceipt_accountId_createdAt_idx" ON "MasterAnalysisReceipt"("accountId", "createdAt");
CREATE UNIQUE INDEX "MasterCandidate_candidateKey_key" ON "MasterCandidate"("candidateKey");
CREATE UNIQUE INDEX "MasterCandidate_snapshotId_personId_decisionPly_configHash_key" ON "MasterCandidate"("snapshotId", "personId", "decisionPly", "configHash");
CREATE INDEX "MasterCandidate_hardGatePassed_totalScore_createdAt_idx" ON "MasterCandidate"("hardGatePassed", "totalScore", "createdAt");
CREATE INDEX "MasterCandidate_personId_status_idx" ON "MasterCandidate"("personId", "status");
CREATE INDEX "MasterCandidate_pipelineRunId_status_idx" ON "MasterCandidate"("pipelineRunId", "status");
CREATE UNIQUE INDEX "MasterPublication_slug_key" ON "MasterPublication"("slug");
CREATE UNIQUE INDEX "MasterPublication_candidateId_key" ON "MasterPublication"("candidateId");
CREATE UNIQUE INDEX "MasterPublication_contentHash_key" ON "MasterPublication"("contentHash");
CREATE INDEX "MasterPublication_status_health_publishedAt_idx" ON "MasterPublication"("status", "health", "publishedAt");
CREATE INDEX "MasterPublication_isFallback_status_idx" ON "MasterPublication"("isFallback", "status");
CREATE UNIQUE INDEX "MasterSlot_key_key" ON "MasterSlot"("key");
CREATE INDEX "MasterSlot_currentPublicationId_idx" ON "MasterSlot"("currentPublicationId");
CREATE INDEX "MasterSlot_fallbackPublicationId_idx" ON "MasterSlot"("fallbackPublicationId");
CREATE INDEX "MasterAdminOverride_slotId_startsAt_expiresAt_idx" ON "MasterAdminOverride"("slotId", "startsAt", "expiresAt");
CREATE INDEX "MasterAdminOverride_personId_startsAt_expiresAt_idx" ON "MasterAdminOverride"("personId", "startsAt", "expiresAt");
CREATE INDEX "MasterAdminOverride_accountId_startsAt_expiresAt_idx" ON "MasterAdminOverride"("accountId", "startsAt", "expiresAt");
CREATE INDEX "MasterAdminOverride_publicationId_startsAt_expiresAt_idx" ON "MasterAdminOverride"("publicationId", "startsAt", "expiresAt");
CREATE INDEX "MasterAdminOverride_expiresAt_revokedAt_idx" ON "MasterAdminOverride"("expiresAt", "revokedAt");

ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminMembershipId_fkey" FOREIGN KEY ("adminMembershipId") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OnboardingAnalyticsEvent" ADD CONSTRAINT "OnboardingAnalyticsEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterAccount" ADD CONSTRAINT "MasterAccount_personId_fkey" FOREIGN KEY ("personId") REFERENCES "MasterPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterSourceGameDiscovery" ADD CONSTRAINT "MasterSourceGameDiscovery_sourceGameId_fkey" FOREIGN KEY ("sourceGameId") REFERENCES "MasterSourceGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterSourceGameDiscovery" ADD CONSTRAINT "MasterSourceGameDiscovery_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MasterAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterSourceGameSnapshot" ADD CONSTRAINT "MasterSourceGameSnapshot_sourceGameId_fkey" FOREIGN KEY ("sourceGameId") REFERENCES "MasterSourceGame"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterSourceGameSnapshot" ADD CONSTRAINT "MasterSourceGameSnapshot_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "MasterPipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterSourceGame" ADD CONSTRAINT "MasterSourceGame_currentSnapshotId_fkey" FOREIGN KEY ("currentSnapshotId") REFERENCES "MasterSourceGameSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterAnalysisReceipt" ADD CONSTRAINT "MasterAnalysisReceipt_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MasterSourceGameSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterAnalysisReceipt" ADD CONSTRAINT "MasterAnalysisReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MasterAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterAnalysisReceipt" ADD CONSTRAINT "MasterAnalysisReceipt_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "MasterPipelineRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterCandidate" ADD CONSTRAINT "MasterCandidate_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MasterSourceGameSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterCandidate" ADD CONSTRAINT "MasterCandidate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "MasterPerson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterCandidate" ADD CONSTRAINT "MasterCandidate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MasterAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterCandidate" ADD CONSTRAINT "MasterCandidate_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "MasterPipelineRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterPublication" ADD CONSTRAINT "MasterPublication_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "MasterCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterSlot" ADD CONSTRAINT "MasterSlot_currentPublicationId_fkey" FOREIGN KEY ("currentPublicationId") REFERENCES "MasterPublication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterSlot" ADD CONSTRAINT "MasterSlot_fallbackPublicationId_fkey" FOREIGN KEY ("fallbackPublicationId") REFERENCES "MasterPublication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "MasterSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_personId_fkey" FOREIGN KEY ("personId") REFERENCES "MasterPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MasterAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "MasterPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_targetPublicationId_fkey" FOREIGN KEY ("targetPublicationId") REFERENCES "MasterPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MasterAdminOverride" ADD CONSTRAINT "MasterAdminOverride_revokedByAdminId_fkey" FOREIGN KEY ("revokedByAdminId") REFERENCES "AdminMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- All new tables are private server-side data. Public reads and anonymous
-- analytics writes go through validated application routes, never PostgREST.
ALTER TABLE public."AdminMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AdminAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."OnboardingAnalyticsEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."OnboardingRateBucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPerson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPipelineRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGame" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGameDiscovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGameSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAnalysisReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPublication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAdminOverride" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."AdminMembership" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."AdminAuditLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."OnboardingAnalyticsEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."OnboardingRateBucket" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPerson" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAccount" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPipelineRun" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGame" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGameDiscovery" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSourceGameSnapshot" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAnalysisReceipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterCandidate" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterPublication" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterSlot" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."MasterAdminOverride" FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."AdminMembership" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AdminAuditLog" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."OnboardingAnalyticsEvent" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."OnboardingRateBucket" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterPerson" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterAccount" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterPipelineRun" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterSourceGame" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterSourceGameDiscovery" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterSourceGameSnapshot" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterAnalysisReceipt" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterCandidate" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterPublication" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterSlot" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."MasterAdminOverride" FROM anon, authenticated;
