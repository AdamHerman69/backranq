import { isRecord, isStrictIsoInstant } from '@/lib/api/validation';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLOT_KEY_RE = /^[a-z0-9][a-z0-9:_-]{2,63}$/i;
const COMMAND_FIELDS: Record<string, readonly string[]> = {
    FORCE_PIPELINE: ['type', 'scope', 'reason'],
    ANALYZE_SOURCE_GAME: ['type', 'sourceGameId', 'reason'],
    APPROVE_CANDIDATE: ['type', 'candidateId', 'reason'],
    EXCLUDE_CANDIDATE: ['type', 'candidateId', 'reason'],
    SELECT_CANDIDATE: [
        'type',
        'candidateId',
        'slotKey',
        'expiresAt',
        'reason',
    ],
    PIN_PUBLICATION: [
        'type',
        'publicationId',
        'slotKey',
        'expiresAt',
        'reason',
    ],
    FORCE_FALLBACK: ['type', 'slotKey', 'expiresAt', 'reason'],
    PAUSE_AUTOMATION: ['type', 'expiresAt', 'reason'],
    EXCLUDE_PERSON: ['type', 'personId', 'expiresAt', 'reason'],
    EXCLUDE_ACCOUNT: ['type', 'accountId', 'expiresAt', 'reason'],
    WITHDRAW_PUBLICATION: ['type', 'publicationId', 'expiresAt', 'reason'],
    REVOKE_OVERRIDE: ['type', 'overrideId', 'reason'],
};

export type MasterPipelineStage = {
    id: string;
    runKey: string;
    status: string;
    stage: string;
    trigger: string;
    scheduledFor: string;
    startedAt: string | null;
    completedAt: string | null;
    lastError: string | null;
    attempts: number;
};

export type MasterRosterPerson = {
    id: string;
    displayName: string;
    attributionLabel: string;
    priority: number;
    active: boolean;
    excludedUntil: string | null;
    accounts: Array<{
        id: string;
        provider: string;
        username: string;
        profileUrl: string;
        active: boolean;
        identityVerifiedAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        excludedUntil: string | null;
    }>;
};

export type MasterSourceGameSummary = {
    id: string;
    personLabel: string;
    provider: string;
    externalId: string;
    canonicalUrl: string;
    availability: string;
    playedAt: string | null;
    matchup: string | null;
    lastSeenAt: string;
};

export type MasterCandidateSummary = {
    id: string;
    personLabel: string;
    sourceGameId: string;
    sourceUrl: string;
    decisionPly: number;
    fen: string;
    originalMoveUci: string;
    bestMoveUci: string | null;
    score: number;
    status: string;
    hardGatePassed: boolean;
    rejectionReasons: string[];
    evidenceSummary: string;
    publicationId: string | null;
};

export type MasterPublicationSummary = {
    id: string;
    slug: string;
    candidateId: string | null;
    headline: string;
    attribution: string;
    status: string;
    health: string;
    sourceUrl: string;
    isFallback: boolean;
    publishedAt: string | null;
    staleAt: string | null;
};

export type WeeklyMasterAdminSnapshot = {
    generatedAt: string;
    automation: {
        mode: 'AUTONOMOUS' | 'PAUSED';
        pausedUntil: string | null;
        activeOverrideCount: number;
        currentSlotKey: string | null;
        currentPublicationId: string | null;
        fallbackPublicationId: string | null;
    };
    stats: {
        users: number;
        linkedAccounts: number;
        sourceGames: number;
        eligibleCandidates: number;
        publishedPuzzles: number;
        failedRuns: number;
    };
    onboardingFunnel: {
        windowDays: number;
        landingViewed: number;
        identitySubmitted: number;
        lookupSucceeded: number;
        analysisStarted: number;
        analysisFailed: number;
        personalReady: number;
        masterTerminal: number;
        handoffClicked: number;
        personalStarted: number;
        personalTerminal: number;
        activationRate: number | null;
        readinessMedianMs: number | null;
        readinessP90Ms: number | null;
    };
    activeOverrides: Array<{
        id: string;
        kind: string;
        targetLabel: string;
        expiresAt: string;
        reason: string;
    }>;
    latestRuns: MasterPipelineStage[];
    roster: MasterRosterPerson[];
    sourceGames: MasterSourceGameSummary[];
    candidates: MasterCandidateSummary[];
    publications: MasterPublicationSummary[];
    recentUsers: Array<{
        id: string;
        displayName: string;
        createdAt: string;
        linkedProviders: string[];
        gameCount: number;
        lastAnalysisAt: string | null;
    }>;
};

type CommandBase = {
    reason: string;
};

export type MasterAdminCommand =
    | (CommandBase & {
          type: 'FORCE_PIPELINE';
          scope: 'FULL' | 'INGEST' | 'ANALYSIS';
      })
    | (CommandBase & {
          type: 'ANALYZE_SOURCE_GAME';
          sourceGameId: string;
      })
    | (CommandBase & {
          type: 'APPROVE_CANDIDATE' | 'EXCLUDE_CANDIDATE';
          candidateId: string;
      })
    | (CommandBase & {
          type: 'SELECT_CANDIDATE';
          candidateId: string;
          slotKey: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'PIN_PUBLICATION';
          publicationId: string;
          slotKey: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'FORCE_FALLBACK';
          slotKey: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'PAUSE_AUTOMATION';
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'EXCLUDE_PERSON';
          personId: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'EXCLUDE_ACCOUNT';
          accountId: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'WITHDRAW_PUBLICATION';
          publicationId: string;
          expiresAt: string;
      })
    | (CommandBase & {
          type: 'REVOKE_OVERRIDE';
          overrideId: string;
      });

export type ParseMasterAdminCommandResult =
    | { ok: true; value: MasterAdminCommand }
    | { ok: false; error: string };

function requiredReason(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const reason = value.trim();
    return reason.length >= 4 && reason.length <= 500 ? reason : null;
}

function uuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

function futureInstant(value: unknown, now: Date): value is string {
    if (!isStrictIsoInstant(value)) return false;
    const timestamp = new Date(value).getTime();
    return timestamp > now.getTime() && timestamp <= now.getTime() + 90 * 86_400_000;
}

export function parseMasterAdminCommand(
    value: unknown,
    now = new Date()
): ParseMasterAdminCommandResult {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return { ok: false, error: 'Invalid admin command' };
    }
    const reason = requiredReason(value.reason);
    if (!reason) {
        return {
            ok: false,
            error: 'A reason between 4 and 500 characters is required',
        };
    }
    const allowedFields = COMMAND_FIELDS[value.type];
    if (
        allowedFields &&
        Object.keys(value).some((key) => !allowedFields.includes(key))
    ) {
        return { ok: false, error: 'Unknown admin command field' };
    }

    switch (value.type) {
        case 'FORCE_PIPELINE':
            if (
                value.scope !== 'FULL' &&
                value.scope !== 'INGEST' &&
                value.scope !== 'ANALYSIS'
            ) {
                return { ok: false, error: 'Invalid pipeline scope' };
            }
            return {
                ok: true,
                value: { type: value.type, scope: value.scope, reason },
            };
        case 'ANALYZE_SOURCE_GAME':
            if (!uuid(value.sourceGameId)) {
                return { ok: false, error: 'Invalid source game id' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    sourceGameId: value.sourceGameId,
                    reason,
                },
            };
        case 'APPROVE_CANDIDATE':
        case 'EXCLUDE_CANDIDATE':
            if (!uuid(value.candidateId)) {
                return { ok: false, error: 'Invalid candidate id' };
            }
            return {
                ok: true,
                value: { type: value.type, candidateId: value.candidateId, reason },
            };
        case 'SELECT_CANDIDATE':
            if (
                !uuid(value.candidateId) ||
                typeof value.slotKey !== 'string' ||
                !SLOT_KEY_RE.test(value.slotKey) ||
                !futureInstant(value.expiresAt, now)
            ) {
                return { ok: false, error: 'Invalid candidate selection' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    candidateId: value.candidateId,
                    slotKey: value.slotKey,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'PIN_PUBLICATION':
            if (
                !uuid(value.publicationId) ||
                typeof value.slotKey !== 'string' ||
                !SLOT_KEY_RE.test(value.slotKey) ||
                !futureInstant(value.expiresAt, now)
            ) {
                return { ok: false, error: 'Invalid publication pin' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    publicationId: value.publicationId,
                    slotKey: value.slotKey,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'FORCE_FALLBACK':
            if (
                typeof value.slotKey !== 'string' ||
                !SLOT_KEY_RE.test(value.slotKey) ||
                !futureInstant(value.expiresAt, now)
            ) {
                return { ok: false, error: 'Invalid fallback override' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    slotKey: value.slotKey,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'PAUSE_AUTOMATION':
            if (!futureInstant(value.expiresAt, now)) {
                return { ok: false, error: 'Invalid pause expiry' };
            }
            return {
                ok: true,
                value: { type: value.type, expiresAt: value.expiresAt, reason },
            };
        case 'EXCLUDE_PERSON':
            if (!uuid(value.personId) || !futureInstant(value.expiresAt, now)) {
                return { ok: false, error: 'Invalid person exclusion' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    personId: value.personId,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'EXCLUDE_ACCOUNT':
            if (!uuid(value.accountId) || !futureInstant(value.expiresAt, now)) {
                return { ok: false, error: 'Invalid account exclusion' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    accountId: value.accountId,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'WITHDRAW_PUBLICATION':
            if (!uuid(value.publicationId) || !futureInstant(value.expiresAt, now)) {
                return { ok: false, error: 'Invalid publication id' };
            }
            return {
                ok: true,
                value: {
                    type: value.type,
                    publicationId: value.publicationId,
                    expiresAt: value.expiresAt,
                    reason,
                },
            };
        case 'REVOKE_OVERRIDE':
            if (!uuid(value.overrideId)) {
                return { ok: false, error: 'Invalid override id' };
            }
            return {
                ok: true,
                value: { type: value.type, overrideId: value.overrideId, reason },
            };
        default:
            return { ok: false, error: 'Unknown admin command' };
    }
}
