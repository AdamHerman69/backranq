import {
    createHash,
    createHmac,
    randomUUID,
    timingSafeEqual,
} from 'node:crypto';
import { Prisma } from '@prisma/client';

import {
    normalizedGameToDb,
    parseExternalId,
    providerToDb,
} from '@/lib/api/games';
import { isRecord, isStrictIsoInstant } from '@/lib/api/validation';
import { isValidSourcePgn } from '@/lib/chess/pgn';
import { normalizeChessUsername } from '@/lib/games/outcome';
import { prisma } from '@/lib/prisma';
import { fetchChessComGamesBatch } from '@/lib/providers/chesscom';
import { fetchLichessGamesBatch } from '@/lib/providers/lichess';
import type { NormalizedGame } from '@/lib/types/game';

export const HISTORY_IMPORT_LIMIT = 2_000;
export const HISTORY_IMPORT_REQUEST_LIMIT = 200;
export const HISTORY_IMPORT_BODY_LIMIT_BYTES = 8_000_000;
export const HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES = 6_000_000;

const MAX_PGN_LENGTH = 2_000_000;
const MAX_TEXT_LENGTH = 20_000;
const HISTORY_FETCH_TIMEOUT_MS = 30_000;
const HISTORY_FETCH_LEASE_MS = HISTORY_FETCH_TIMEOUT_MS + 5_000;
const HISTORY_PROVIDER_PAGE_SIZE = 200;
const HISTORY_TICKET_TTL_MS = 60 * 60 * 1_000;
const HISTORY_CURSOR_TTL_MS = 60 * 60 * 1_000;
export const HISTORY_CURSOR_MAX_LENGTH = 16_384;

export type HistoryImportProvider = 'lichess' | 'chesscom';
export type HistoryImportFilters = {
    timeClasses: NormalizedGame['timeClass'][];
    rated: boolean | undefined;
    since: string | undefined;
    until: string | undefined;
};

export type HistoryImportAllowance = {
    limit: number;
    used: number;
    remaining: number;
};

export type HistoryImportSnapshotRow = {
    game: NormalizedGame;
    ticket: string;
};

export type HistoryImportTruncatedReason =
    | 'allowance'
    | 'response-size'
    | 'provider-page'
    | null;

export type HistoryImportSnapshot = {
    ownerId: string;
    provider: HistoryImportProvider;
    username: string;
    rows: HistoryImportSnapshotRow[];
    allowance: HistoryImportAllowance;
    fetched: number;
    existingCount: number;
    truncatedReason: HistoryImportTruncatedReason;
    providerComplete: boolean;
    nextCursor: string | null;
    page: number;
};

export type HistoryImportError = {
    index: number;
    id?: string;
    kind: 'validation' | 'save';
    error: string;
};

export type HistoryImportResult = {
    provider: HistoryImportProvider;
    imported: number;
    duplicates: number;
    failed: number;
    capRejected: number;
    ids: Record<string, string>;
    errors: HistoryImportError[];
    allowance: HistoryImportAllowance;
};

export class HistoryImportProviderNotLinkedError extends Error {
    constructor(provider: HistoryImportProvider) {
        super(
            `${provider === 'lichess' ? 'Lichess' : 'Chess.com'} is not linked to this account`
        );
        this.name = 'HistoryImportProviderNotLinkedError';
    }
}

export class HistoryImportConcurrencyError extends Error {
    constructor() {
        super('History import changed concurrently; retry the import');
        this.name = 'HistoryImportConcurrencyError';
    }
}

export class HistoryImportProviderTimeoutError extends Error {
    constructor() {
        super('The chess provider took too long to return older games');
        this.name = 'HistoryImportProviderTimeoutError';
    }
}

export class HistoryImportProviderFetchError extends Error {
    constructor(
        message: string,
        readonly httpStatus: number,
        readonly sourceStatus: number | null,
        readonly retryable: boolean
    ) {
        super(message);
        this.name = 'HistoryImportProviderFetchError';
    }
}

export class HistoryImportRateLimitError extends Error {
    constructor(readonly retryAfterMs: number) {
        super('An older-games request for this source is already running. Try again shortly.');
        this.name = 'HistoryImportRateLimitError';
    }
}

export class HistoryImportConfigurationError extends Error {
    constructor() {
        super('History import signing is not configured');
        this.name = 'HistoryImportConfigurationError';
    }
}

export class HistoryImportCursorError extends Error {
    constructor(
        message = 'History page cursor is invalid or expired',
        readonly httpStatus = 400,
        readonly resetRequired = true
    ) {
        super(message);
        this.name = 'HistoryImportCursorError';
    }
}

type HistoryTicketPayload = {
    v: 1;
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    externalId: string;
    contentHash: string;
    expiresAt: number;
};

type HistoryCursorPayload = {
    v: 1;
    purpose: 'history-import-page';
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    filtersHash: string;
    until: string;
    boundaryIds: string[];
    page: number;
    expiresAt: number;
};

function canonicalJson(value: unknown): string {
    if (value === undefined) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
            .filter((key) => object[key] !== undefined)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
            )
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
}

function historyTicketSecret() {
    const secret = process.env.NEXTAUTH_SECRET?.trim();
    if (!secret) {
        throw new HistoryImportConfigurationError();
    }
    return secret;
}

function gameContentHash(game: NormalizedGame) {
    return createHash('sha256')
        .update(canonicalJson(game))
        .digest('base64url');
}

function historyFiltersHash(filters: HistoryImportFilters) {
    const normalized = {
        timeClasses: Array.from(new Set(filters.timeClasses)).sort(),
        rated: filters.rated ?? null,
        since: filters.since ?? null,
        until: filters.until ?? null,
    };
    return createHash('sha256')
        .update(canonicalJson(normalized))
        .digest('base64url');
}

function signHistoryCursorPayload(payload: HistoryCursorPayload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString(
        'base64url'
    );
    const signature = createHmac('sha256', historyTicketSecret())
        .update(`history-import-page:${encoded}`)
        .digest('base64url');
    const cursor = `${encoded}.${signature}`;
    if (cursor.length > HISTORY_CURSOR_MAX_LENGTH) {
        throw new HistoryImportCursorError(
            'History pagination cannot safely continue at this timestamp. Narrow the date range and start over.',
            409
        );
    }
    return cursor;
}

export function issueHistoryImportCursor(args: {
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    filters: HistoryImportFilters;
    until: string;
    boundaryIds?: string[];
    page: number;
    now?: number;
}) {
    if (
        !isStrictIsoInstant(args.until) ||
        !Number.isSafeInteger(args.page) ||
        args.page < 2 ||
        (args.boundaryIds?.length ?? 0) > HISTORY_PROVIDER_PAGE_SIZE ||
        (args.boundaryIds ?? []).some(
            (id) => !nonEmptyString(id, 500)
        )
    ) {
        throw new HistoryImportCursorError(
            'History provider returned an unsafe pagination boundary',
            409
        );
    }
    return signHistoryCursorPayload({
        v: 1,
        purpose: 'history-import-page',
        userId: args.userId,
        provider: args.provider,
        usernameNormalized: args.usernameNormalized,
        filtersHash: historyFiltersHash(args.filters),
        until: args.until,
        boundaryIds: Array.from(new Set(args.boundaryIds ?? [])),
        page: args.page,
        expiresAt: (args.now ?? Date.now()) + HISTORY_CURSOR_TTL_MS,
    });
}

function readHistoryImportCursor(args: {
    cursor: string;
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    filters: HistoryImportFilters;
    now?: number;
}): HistoryCursorPayload {
    if (
        !args.cursor ||
        args.cursor.length > HISTORY_CURSOR_MAX_LENGTH
    ) {
        throw new HistoryImportCursorError();
    }
    const [encoded, signature, extra] = args.cursor.split('.');
    if (!encoded || !signature || extra) {
        throw new HistoryImportCursorError();
    }
    const encodedPayload = decodeCanonicalBase64Url(encoded);
    const receivedSignature = decodeCanonicalBase64Url(signature);
    if (!encodedPayload || !receivedSignature) {
        throw new HistoryImportCursorError();
    }
    const expectedSignature = createHmac(
        'sha256',
        historyTicketSecret()
    )
        .update(`history-import-page:${encoded}`)
        .digest();
    if (
        expectedSignature.length !== receivedSignature.length ||
        !timingSafeEqual(expectedSignature, receivedSignature)
    ) {
        throw new HistoryImportCursorError();
    }

    let payload: unknown;
    try {
        payload = JSON.parse(encodedPayload.toString('utf8')) as unknown;
    } catch {
        throw new HistoryImportCursorError();
    }
    if (
        !isRecord(payload) ||
        payload.v !== 1 ||
        payload.purpose !== 'history-import-page' ||
        typeof payload.expiresAt !== 'number' ||
        !Number.isSafeInteger(payload.expiresAt) ||
        typeof payload.until !== 'string' ||
        !isStrictIsoInstant(payload.until) ||
        !Array.isArray(payload.boundaryIds) ||
        payload.boundaryIds.length > HISTORY_PROVIDER_PAGE_SIZE ||
        payload.boundaryIds.some((id) => !nonEmptyString(id, 500)) ||
        typeof payload.page !== 'number' ||
        !Number.isSafeInteger(payload.page) ||
        payload.page < 2
    ) {
        throw new HistoryImportCursorError();
    }
    if (payload.expiresAt < (args.now ?? Date.now())) {
        throw new HistoryImportCursorError(
            'History page expired. Start over to continue safely.',
            409
        );
    }
    if (
        payload.userId !== args.userId ||
        payload.provider !== args.provider ||
        payload.usernameNormalized !== args.usernameNormalized ||
        payload.filtersHash !== historyFiltersHash(args.filters)
    ) {
        throw new HistoryImportCursorError(
            'History filters or linked account changed. Start over to continue safely.',
            409
        );
    }
    return payload as unknown as HistoryCursorPayload;
}

export function issueHistoryImportTicket(args: {
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    game: NormalizedGame;
    now?: number;
}) {
    const payload: HistoryTicketPayload = {
        v: 1,
        userId: args.userId,
        provider: args.provider,
        usernameNormalized: args.usernameNormalized,
        externalId: parseExternalId(args.game),
        contentHash: gameContentHash(args.game),
        expiresAt: (args.now ?? Date.now()) + HISTORY_TICKET_TTL_MS,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString(
        'base64url'
    );
    const signature = createHmac('sha256', historyTicketSecret())
        .update(encoded)
        .digest('base64url');
    return `${encoded}.${signature}`;
}

function verifyHistoryTicket(args: {
    ticket: string;
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
    game: NormalizedGame;
    now?: number;
}) {
    const [encoded, signature, extra] = args.ticket.split('.');
    if (!encoded || !signature || extra) return false;
    const encodedPayload = decodeCanonicalBase64Url(encoded);
    const receivedSignature = decodeCanonicalBase64Url(signature);
    if (!encodedPayload || !receivedSignature) return false;
    const expectedSignature = createHmac(
        'sha256',
        historyTicketSecret()
    )
        .update(encoded)
        .digest();
    if (
        expectedSignature.length !== receivedSignature.length ||
        !timingSafeEqual(expectedSignature, receivedSignature)
    ) {
        return false;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(encodedPayload.toString('utf8')) as unknown;
    } catch {
        return false;
    }
    if (!isRecord(payload)) return false;
    return (
        payload.v === 1 &&
        payload.userId === args.userId &&
        payload.provider === args.provider &&
        payload.usernameNormalized === args.usernameNormalized &&
        payload.externalId === parseExternalId(args.game) &&
        payload.contentHash === gameContentHash(args.game) &&
        typeof payload.expiresAt === 'number' &&
        Number.isSafeInteger(payload.expiresAt) &&
        payload.expiresAt >= (args.now ?? Date.now())
    );
}

function providerUsername(
    provider: HistoryImportProvider,
    user: {
        lichessUsername: string | null;
        chesscomUsername: string | null;
    }
) {
    return provider === 'lichess'
        ? user.lichessUsername
        : user.chesscomUsername;
}

function allowance(createdCount: number): HistoryImportAllowance {
    const used = Math.max(
        0,
        Math.min(HISTORY_IMPORT_LIMIT, Math.trunc(createdCount))
    );
    return {
        limit: HISTORY_IMPORT_LIMIT,
        used,
        remaining: HISTORY_IMPORT_LIMIT - used,
    };
}

function nonEmptyString(
    value: unknown,
    maxLength = MAX_TEXT_LENGTH
): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength
    );
}

function optionalString(
    value: unknown,
    maxLength = MAX_TEXT_LENGTH
): value is string | null | undefined {
    return (
        value == null ||
        (typeof value === 'string' && value.length <= maxLength)
    );
}

function optionalRating(
    value: unknown
): value is number | null | undefined {
    return (
        value == null ||
        (typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 5_000)
    );
}

function optionalNonnegativeInteger(value: unknown) {
    return (
        value == null ||
        (typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0)
    );
}

function isTimeClass(value: unknown): value is NormalizedGame['timeClass'] {
    return (
        value === 'bullet' ||
        value === 'blitz' ||
        value === 'rapid' ||
        value === 'classical' ||
        value === 'unknown'
    );
}

export function validateHistoryImportGame(args: {
    value: unknown;
    index: number;
    provider: HistoryImportProvider;
    usernameNormalized: string;
}): { game: NormalizedGame } | { error: HistoryImportError } {
    const { value, index, provider, usernameNormalized } = args;
    if (!isRecord(value)) {
        return {
            error: {
                index,
                kind: 'validation',
                error: 'Invalid game',
            },
        };
    }
    const id = typeof value.id === 'string' ? value.id : undefined;
    if (
        !id ||
        id.length > 500 ||
        !id.startsWith(`${provider}:`) ||
        value.provider !== provider
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Game does not match the selected provider',
            },
        };
    }
    if (!isStrictIsoInstant(value.playedAt)) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid playedAt',
            },
        };
    }
    if (!isTimeClass(value.timeClass)) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid timeClass',
            },
        };
    }
    if (
        !optionalString(value.url, 2_048) ||
        !optionalString(value.result, 200) ||
        !optionalString(value.termination, 500)
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid game metadata',
            },
        };
    }
    if (
        !nonEmptyString(value.pgn, MAX_PGN_LENGTH) ||
        !isValidSourcePgn(value.pgn)
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid pgn',
            },
        };
    }

    const white = isRecord(value.white) ? value.white : null;
    const black = isRecord(value.black) ? value.black : null;
    if (
        !white ||
        !black ||
        !nonEmptyString(white.name, 200) ||
        !nonEmptyString(black.name, 200)
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid players',
            },
        };
    }
    if (
        normalizeChessUsername(white.name) !== usernameNormalized &&
        normalizeChessUsername(black.name) !== usernameNormalized
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Game does not belong to the linked chess account',
            },
        };
    }
    if (!optionalRating(white.rating) || !optionalRating(black.rating)) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid ratings',
            },
        };
    }
    if (value.rated != null && typeof value.rated !== 'boolean') {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid rated flag',
            },
        };
    }

    const whiteMatches =
        normalizeChessUsername(white.name) === usernameNormalized;
    const blackMatches =
        normalizeChessUsername(black.name) === usernameNormalized;
    const provenance = isRecord(value.provenance)
        ? value.provenance
        : null;
    const provenanceUsername =
        typeof provenance?.username === 'string'
            ? provenance.username.trim()
            : usernameNormalized;
    if (
        !provenanceUsername ||
        provenanceUsername.length > 200 ||
        normalizeChessUsername(provenanceUsername) !== usernameNormalized
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid game provenance',
            },
        };
    }
    if (
        provenance?.accountId != null &&
        (typeof provenance.accountId !== 'string' ||
            !provenance.accountId.trim() ||
            provenance.accountId.length > 500)
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid game provenance',
            },
        };
    }
    const timeControl = isRecord(provenance?.timeControl)
        ? provenance.timeControl
        : null;
    if (
        (timeControl?.raw != null &&
            (typeof timeControl.raw !== 'string' ||
                timeControl.raw.length > 200)) ||
        !optionalNonnegativeInteger(timeControl?.initialSeconds) ||
        !optionalNonnegativeInteger(timeControl?.incrementSeconds)
    ) {
        return {
            error: {
                index,
                id,
                kind: 'validation',
                error: 'Invalid time control provenance',
            },
        };
    }

    return {
        game: {
            id,
            provider,
            url: typeof value.url === 'string' ? value.url : undefined,
            playedAt: value.playedAt,
            timeClass: value.timeClass,
            rated:
                typeof value.rated === 'boolean' ? value.rated : undefined,
            white: {
                name: white.name,
                rating:
                    typeof white.rating === 'number'
                        ? white.rating
                        : undefined,
            },
            black: {
                name: black.name,
                rating:
                    typeof black.rating === 'number'
                        ? black.rating
                        : undefined,
            },
            result:
                typeof value.result === 'string' ? value.result : undefined,
            termination:
                typeof value.termination === 'string'
                    ? value.termination
                    : undefined,
            pgn: value.pgn,
            provenance: provenance
                ? {
                      username: provenanceUsername,
                      accountId:
                          typeof provenance.accountId === 'string'
                              ? provenance.accountId.trim()
                              : undefined,
                      userSide:
                          whiteMatches && !blackMatches
                              ? 'white'
                              : blackMatches && !whiteMatches
                                ? 'black'
                                : 'unknown',
                      timeControl: timeControl
                          ? {
                                raw:
                                    typeof timeControl.raw === 'string'
                                        ? timeControl.raw
                                        : undefined,
                                initialSeconds:
                                    typeof timeControl.initialSeconds ===
                                    'number'
                                        ? timeControl.initialSeconds
                                        : undefined,
                                incrementSeconds:
                                    typeof timeControl.incrementSeconds ===
                                    'number'
                                        ? timeControl.incrementSeconds
                                        : undefined,
                            }
                          : undefined,
                  }
                : undefined,
        },
    };
}

async function linkedIdentity(
    userId: string,
    provider: HistoryImportProvider,
    client: Pick<Prisma.TransactionClient, 'user'> = prisma
) {
    const user = await client.user.findUnique({
        where: { id: userId },
        select: {
            lichessUsername: true,
            chesscomUsername: true,
            accounts: {
                where: { provider: 'lichess' },
                select: { access_token: true },
                take: 1,
            },
        },
    });
    const username = user ? providerUsername(provider, user)?.trim() : null;
    if (!username) throw new HistoryImportProviderNotLinkedError(provider);
    return {
        username,
        usernameNormalized: normalizeChessUsername(username),
        // OAuth is an optional throughput optimization for Lichess exports.
        // Username-linked accounts without an OAuth account still use the
        // provider's public endpoint.
        lichessAccessToken:
            provider === 'lichess'
                ? (user?.accounts[0]?.access_token ?? null)
                : null,
    };
}

async function lockedLinkedIdentity(
    tx: Prisma.TransactionClient,
    userId: string,
    provider: HistoryImportProvider
) {
    const rows = await tx.$queryRaw<
        Array<{
            lichessUsername: string | null;
            chesscomUsername: string | null;
        }>
    >`
        SELECT "lichessUsername", "chesscomUsername"
        FROM "User"
        WHERE "id" = ${userId}::uuid
        FOR UPDATE
    `;
    const user = rows[0];
    const username = user ? providerUsername(provider, user)?.trim() : null;
    if (!username) throw new HistoryImportProviderNotLinkedError(provider);
    return {
        username,
        usernameNormalized: normalizeChessUsername(username),
    };
}

function providerStatus(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /\((\d{3})\)/.exec(message);
    return match ? Number(match[1]) : null;
}

async function fetchProviderPage(args: {
    provider: HistoryImportProvider;
    username: string;
    filters: HistoryImportFilters;
    until: string;
    boundaryIds: string[];
    lichessAccessToken?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
}) {
    const providerTimeoutMs = HISTORY_FETCH_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(
        Math.max(
            1,
            Math.min(
                providerTimeoutMs,
                Math.trunc(args.timeoutMs ?? providerTimeoutMs)
            )
        )
    );
    const signal = args.signal
        ? AbortSignal.any([args.signal, deadline])
        : deadline;
    try {
        if (args.provider === 'lichess') {
            return await fetchLichessGamesBatch({
                username: args.username,
                accessToken: args.lichessAccessToken,
                since: args.filters.since,
                until: args.until,
                timeClasses: args.filters.timeClasses,
                rated: args.filters.rated,
                maxPages: 1,
                pageSize: HISTORY_PROVIDER_PAGE_SIZE,
                resumeBoundaryIds: args.boundaryIds,
                signal,
            });
        }
        return await fetchChessComGamesBatch({
            username: args.username,
            since: args.filters.since,
            until: args.until,
            timeClasses: args.filters.timeClasses,
            rated: args.filters.rated,
            maxArchives: 1,
            signal,
        });
    } catch (error) {
        if (deadline.aborted && !args.signal?.aborted) {
            throw new HistoryImportProviderTimeoutError();
        }
        if (args.signal?.aborted) throw error;
        const status = providerStatus(error);
        if (status === 429) {
            throw new HistoryImportProviderFetchError(
                'The chess provider is rate limiting history imports. Try again shortly.',
                429,
                429,
                true
            );
        }
        if (status != null && status >= 500) {
            throw new HistoryImportProviderFetchError(
                'The chess provider is temporarily unavailable. Try again later.',
                503,
                status,
                true
            );
        }
        throw new HistoryImportProviderFetchError(
            'The chess provider returned an invalid history response.',
            502,
            status,
            false
        );
    }
}

type HistoryFetchLease = {
    quotaId: string;
    token: string;
};

async function acquireHistoryFetchLease(args: {
    userId: string;
    provider: HistoryImportProvider;
    usernameNormalized: string;
}): Promise<HistoryFetchLease> {
    const provider = providerToDb(args.provider);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + HISTORY_FETCH_LEASE_MS);
    const token = randomUUID();
    const result = await prisma.$transaction(async (tx) => {
        const quota = await tx.historyImportQuota.upsert({
            where: {
                userId_provider_usernameNormalized: {
                    userId: args.userId,
                    provider,
                    usernameNormalized: args.usernameNormalized,
                },
            },
            create: {
                userId: args.userId,
                provider,
                usernameNormalized: args.usernameNormalized,
            },
            update: {},
            select: { id: true },
        });
        const acquired = await tx.historyImportQuota.updateMany({
            where: {
                id: quota.id,
                OR: [
                    { fetchLeaseUntil: null },
                    { fetchLeaseUntil: { lte: now } },
                ],
            },
            data: {
                fetchLeaseToken: token,
                fetchLeaseUntil: leaseUntil,
            },
        });
        if (acquired.count === 1) {
            return {
                acquired: true as const,
                quotaId: quota.id,
            };
        }
        const current = await tx.historyImportQuota.findUnique({
            where: { id: quota.id },
            select: {
                fetchLeaseUntil: true,
            },
        });
        const leaseWait =
            (current?.fetchLeaseUntil?.getTime() ?? now.getTime()) -
            now.getTime();
        return {
            acquired: false as const,
            retryAfterMs: Math.max(1, leaseWait),
        };
    });
    if (!result.acquired) {
        throw new HistoryImportRateLimitError(result.retryAfterMs);
    }
    return {
        quotaId: result.quotaId,
        token,
    };
}

async function releaseHistoryFetchLease(lease: HistoryFetchLease) {
    try {
        await prisma.historyImportQuota.updateMany({
            where: {
                id: lease.quotaId,
                fetchLeaseToken: lease.token,
            },
            data: {
                fetchLeaseToken: null,
                fetchLeaseUntil: null,
            },
        });
    } catch (error) {
        console.error('Failed to release history provider fetch lease', error);
    }
}

export function historySnapshotResponseBytes(
    snapshot: HistoryImportSnapshot
) {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

function rowsWithinSnapshotLimit(args: {
    metadata: Omit<HistoryImportSnapshot, 'rows'>;
    rows: HistoryImportSnapshotRow[];
}) {
    const emptyEnvelopeBytes = historySnapshotResponseBytes({
        ...args.metadata,
        rows: [],
    });
    if (emptyEnvelopeBytes > HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES) {
        throw new HistoryImportCursorError(
            'History page metadata exceeds the response limit. Start over with a narrower date range.',
            409
        );
    }
    const rows: HistoryImportSnapshotRow[] = [];
    let responseBytes = emptyEnvelopeBytes;
    for (const row of args.rows) {
        const rowBytes = Buffer.byteLength(
            JSON.stringify(row),
            'utf8'
        );
        const separatorBytes = rows.length > 0 ? 1 : 0;
        if (
            responseBytes + separatorBytes + rowBytes >
            HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES
        ) {
            break;
        }
        responseBytes += separatorBytes + rowBytes;
        rows.push(row);
    }
    return rows;
}

export async function getHistoryImportSnapshot(args: {
    userId: string;
    provider: HistoryImportProvider;
    filters: HistoryImportFilters;
    cursor?: string;
    signal?: AbortSignal;
    fetchTimeoutMs?: number;
}): Promise<HistoryImportSnapshot> {
    const identity = await linkedIdentity(args.userId, args.provider);
    const provider = providerToDb(args.provider);
    const cursorPayload = args.cursor
        ? readHistoryImportCursor({
              cursor: args.cursor,
              userId: args.userId,
              provider: args.provider,
              usernameNormalized: identity.usernameNormalized,
              filters: args.filters,
          })
        : null;
    const quota = await prisma.historyImportQuota.findUnique({
        where: {
            userId_provider_usernameNormalized: {
                userId: args.userId,
                provider,
                usernameNormalized: identity.usernameNormalized,
            },
        },
        select: { createdCount: true },
    });
    const currentAllowance = allowance(quota?.createdCount ?? 0);
    if (currentAllowance.remaining === 0) {
        return {
            provider: args.provider,
            ownerId: args.userId,
            username: identity.username,
            rows: [] as HistoryImportSnapshotRow[],
            allowance: currentAllowance,
            fetched: 0,
            existingCount: 0,
            truncatedReason: null as HistoryImportTruncatedReason,
            providerComplete: true,
            nextCursor: null,
            page: cursorPayload?.page ?? 1,
        };
    }

    const page = cursorPayload?.page ?? 1;
    const pageUntil =
        cursorPayload?.until ??
        args.filters.until ??
        new Date().toISOString();
    const fetchLease = await acquireHistoryFetchLease({
        userId: args.userId,
        provider: args.provider,
        usernameNormalized: identity.usernameNormalized,
    });
    let providerPage: Awaited<ReturnType<typeof fetchProviderPage>>;
    try {
        providerPage = await fetchProviderPage({
            provider: args.provider,
            username: identity.username,
            filters: args.filters,
            until: pageUntil,
            boundaryIds: cursorPayload?.boundaryIds ?? [],
            lichessAccessToken: identity.lichessAccessToken,
            signal: args.signal,
            timeoutMs: args.fetchTimeoutMs,
        });
    } finally {
        await releaseHistoryFetchLease(fetchLease);
    }
    const fetchedGames = providerPage.games;
    const externalIds = fetchedGames.map(parseExternalId);
    const existing = await prisma.analyzedGame.findMany({
        where: {
            userId: args.userId,
            provider,
            externalId: { in: externalIds },
        },
        select: { externalId: true },
    });
    const existingIds = new Set(existing.map((row) => row.externalId));
    const candidateRows: HistoryImportSnapshotRow[] = [];
    let existingCount = 0;
    for (const game of fetchedGames) {
        if (existingIds.has(parseExternalId(game))) {
            existingCount += 1;
            continue;
        }
        const ticket = issueHistoryImportTicket({
            userId: args.userId,
            provider: args.provider,
            usernameNormalized: identity.usernameNormalized,
            game,
        });
        candidateRows.push({ game, ticket });
    }

    const allowanceLimited =
        candidateRows.length > currentAllowance.remaining;
    const allowanceRows = candidateRows.slice(
        0,
        currentAllowance.remaining
    );
    if (
        !providerPage.complete &&
        !providerPage.nextUntil &&
        !allowanceLimited
    ) {
        throw new HistoryImportCursorError(
            'History provider returned an incomplete page without a safe continuation cursor',
            409
        );
    }
    let nextCursor =
        !allowanceLimited &&
        !providerPage.complete &&
        providerPage.nextUntil
            ? issueHistoryImportCursor({
                  userId: args.userId,
                  provider: args.provider,
                  usernameNormalized: identity.usernameNormalized,
                  filters: args.filters,
                  until: providerPage.nextUntil,
                  boundaryIds: providerPage.nextBoundaryIds,
                  page: page + 1,
              })
            : null;
    let truncatedReason: HistoryImportTruncatedReason =
        allowanceLimited
            ? 'allowance'
            : !providerPage.complete
              ? 'provider-page'
              : null;
    const metadata = {
        ownerId: args.userId,
        provider: args.provider,
        username: identity.username,
        allowance: currentAllowance,
        fetched: fetchedGames.length,
        existingCount,
        truncatedReason,
        providerComplete: providerPage.complete,
        nextCursor,
        page,
    };
    let rows = rowsWithinSnapshotLimit({
        metadata,
        rows: allowanceRows,
    });
    if (rows.length < allowanceRows.length) {
        truncatedReason = 'response-size';
        nextCursor = null;
        rows = rowsWithinSnapshotLimit({
            metadata: {
                ...metadata,
                truncatedReason,
                nextCursor,
            },
            rows: allowanceRows,
        });
    }

    const snapshot: HistoryImportSnapshot = {
        ...metadata,
        rows,
        truncatedReason,
        nextCursor,
    };
    if (
        historySnapshotResponseBytes(snapshot) >
        HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES
    ) {
        throw new Error('History snapshot response accounting failed');
    }
    return snapshot;
}

function retryableTransactionError(error: unknown) {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
    );
}

async function runSerializableWithRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await prisma.$transaction(operation, {
                isolationLevel:
                    Prisma.TransactionIsolationLevel.Serializable,
                timeout: 30_000,
            });
        } catch (error) {
            lastError = error;
            if (!retryableTransactionError(error) || attempt === 2) throw error;
        }
    }
    throw lastError;
}

export async function importHistoricalGames(args: {
    userId: string;
    provider: HistoryImportProvider;
    items: unknown[];
}): Promise<HistoryImportResult> {
    return runSerializableWithRetry(async (tx) => {
        const identity = await lockedLinkedIdentity(
            tx,
            args.userId,
            args.provider
        );
        const provider = providerToDb(args.provider);
        const lockKey = [
            'history-import',
            args.userId,
            provider,
            identity.usernameNormalized,
        ].join(':');

        await tx.$queryRaw<Array<{ acquired: boolean }>>`
            WITH "history_lock" AS MATERIALIZED (
                SELECT pg_advisory_xact_lock(
                    hashtextextended(${lockKey}, 0)
                )
            )
            SELECT TRUE AS "acquired"
            FROM "history_lock"
        `;

        const quota = await tx.historyImportQuota.upsert({
            where: {
                userId_provider_usernameNormalized: {
                    userId: args.userId,
                    provider,
                    usernameNormalized: identity.usernameNormalized,
                },
            },
            create: {
                userId: args.userId,
                provider,
                usernameNormalized: identity.usernameNormalized,
            },
            update: {},
            select: { id: true, createdCount: true },
        });
        const currentAllowance = allowance(quota.createdCount);
        const errors: HistoryImportError[] = [];
        const parsedGames: Array<{
            index: number;
            game: NormalizedGame;
            externalId: string;
        }> = [];
        for (let index = 0; index < args.items.length; index += 1) {
            const item = args.items[index];
            if (
                !isRecord(item) ||
                typeof item.ticket !== 'string' ||
                !('game' in item)
            ) {
                errors.push({
                    index,
                    kind: 'validation',
                    error: 'A valid history snapshot ticket is required',
                });
                continue;
            }
            const parsed = validateHistoryImportGame({
                value: item.game,
                index,
                provider: args.provider,
                usernameNormalized: identity.usernameNormalized,
            });
            if ('error' in parsed) {
                errors.push(parsed.error);
                continue;
            }
            if (
                !verifyHistoryTicket({
                    ticket: item.ticket,
                    userId: args.userId,
                    provider: args.provider,
                    usernameNormalized: identity.usernameNormalized,
                    game: parsed.game,
                })
            ) {
                errors.push({
                    index,
                    id: parsed.game.id,
                    kind: 'validation',
                    error: 'History snapshot ticket is invalid or expired',
                });
                continue;
            }
            if (!parsed.game.provenance) {
                const whiteMatches =
                    normalizeChessUsername(parsed.game.white.name) ===
                    identity.usernameNormalized;
                const blackMatches =
                    normalizeChessUsername(parsed.game.black.name) ===
                    identity.usernameNormalized;
                parsed.game.provenance = {
                    username: identity.username,
                    userSide:
                        whiteMatches && !blackMatches
                            ? 'white'
                            : blackMatches && !whiteMatches
                              ? 'black'
                              : 'unknown',
                };
            }
            parsedGames.push({
                index,
                game: parsed.game,
                externalId: parseExternalId(parsed.game),
            });
        }

        const externalIds = Array.from(
            new Set(parsedGames.map((item) => item.externalId))
        );
        const existing = await tx.analyzedGame.findMany({
            where: {
                userId: args.userId,
                provider,
                externalId: { in: externalIds },
            },
            select: { externalId: true },
        });
        const existingIds = new Set(existing.map((row) => row.externalId));
        const uniqueNew = new Map<
            string,
            { index: number; game: NormalizedGame; externalId: string }
        >();
        let duplicates =
            parsedGames.filter((item) => existingIds.has(item.externalId))
                .length;
        for (const item of parsedGames) {
            if (existingIds.has(item.externalId)) continue;
            if (uniqueNew.has(item.externalId)) {
                duplicates += 1;
                continue;
            }
            uniqueNew.set(item.externalId, item);
        }

        const allNew = Array.from(uniqueNew.values());
        const candidates = allNew.slice(0, currentAllowance.remaining);
        const overCap = allNew.slice(currentAllowance.remaining);
        const created = candidates.length
            ? await tx.analyzedGame.createManyAndReturn({
                  data: candidates.map((item) =>
                      normalizedGameToDb(item.game, args.userId)
                  ),
                  skipDuplicates: true,
                  select: { id: true, externalId: true },
              })
            : [];
        const createdByExternalId = new Map(
            created.map((row) => [row.externalId, row.id])
        );
        duplicates +=
            candidates.length - createdByExternalId.size;

        const capRejected = overCap.length;

        if (created.length > 0) {
            const updated = await tx.historyImportQuota.updateMany({
                where: {
                    id: quota.id,
                    createdCount: {
                        lte: HISTORY_IMPORT_LIMIT - created.length,
                    },
                },
                data: {
                    createdCount: { increment: created.length },
                },
            });
            if (updated.count !== 1) {
                throw new HistoryImportConcurrencyError();
            }
        }

        const ids: Record<string, string> = {};
        for (const item of candidates) {
            const id = createdByExternalId.get(item.externalId);
            if (id) ids[item.game.id] = id;
        }
        const nextAllowance = allowance(
            quota.createdCount + created.length
        );

        return {
            provider: args.provider,
            imported: created.length,
            duplicates,
            failed: errors.length + capRejected,
            capRejected,
            ids,
            errors,
            allowance: nextAllowance,
        };
    });
}
