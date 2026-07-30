import {
    getGameSyncActivity,
    requestGameSync,
    type SyncJobActivity,
    type SyncProvider,
    type UserSyncActivity,
} from '@/lib/services/gameSync';

export const CHESS_CONNECTIONS_CHANGED_EVENT =
    'backranq:chess-connections-changed';

export type IncrementalSyncProviderResult = {
    provider: SyncProvider;
    state:
        | 'started'
        | 'awaiting-worker'
        | 'already-running'
        | 'up-to-date'
        | 'completed'
        | 'failed';
    imported: number | null;
    error: string | null;
    jobId: string | null;
    skippedReason: string | null;
    accepted: boolean;
};

export type IncrementalSyncResult = {
    state:
        | 'started'
        | 'awaiting-worker'
        | 'already-running'
        | 'up-to-date'
        | 'partial'
        | 'failed';
    providers: IncrementalSyncProviderResult[];
    message: string;
    activity: UserSyncActivity | null;
};

type RequestIncrementalSyncOptions = {
    providers?: SyncProvider[];
    onlyIfStaleMinutes?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(
    record: Record<string, unknown>,
    ...keys: string[]
): string | null {
    for (const key of keys) {
        if (typeof record[key] === 'string') return record[key];
    }
    return null;
}

function numberValue(
    record: Record<string, unknown>,
    ...keys: string[]
): number | null {
    for (const key of keys) {
        if (
            typeof record[key] === 'number' &&
            Number.isFinite(record[key])
        ) {
            return record[key];
        }
    }
    return null;
}

function normalizeProviderState(
    raw: Record<string, unknown>
): IncrementalSyncProviderResult['state'] {
    const jobStatus = (stringValue(raw, 'jobStatus') ?? '').toUpperCase();
    if (jobStatus === 'QUEUED' && raw.queuePublished === false) {
        return 'awaiting-worker';
    }
    if (jobStatus === 'RUNNING') return 'already-running';
    if (jobStatus === 'SUCCEEDED') return 'completed';
    if (jobStatus === 'FAILED' || jobStatus === 'CANCELLED') return 'failed';
    if (jobStatus === 'QUEUED') return 'started';
    const rawState = (
        stringValue(raw, 'state', 'status', 'result') ?? ''
    ).toLowerCase();
    const skippedReason = (
        stringValue(raw, 'skippedReason', 'reason') ?? ''
    ).toLowerCase();
    if (
        rawState.includes('already') ||
        rawState.includes('running') ||
        skippedReason.includes('running') ||
        skippedReason.includes('already-queued')
    ) {
        return 'already-running';
    }
    if (
        rawState.includes('fresh') ||
        rawState.includes('up_to_date') ||
        rawState.includes('up-to-date') ||
        rawState.includes('skipped') ||
        skippedReason.includes('fresh') ||
        skippedReason.includes('stale') ||
        skippedReason.includes('disabled')
    ) {
        return 'up-to-date';
    }
    if (
        rawState.includes('fail') ||
        rawState.includes('error') ||
        skippedReason.includes('unlinked') ||
        typeof raw.error === 'string'
    ) {
        return 'failed';
    }
    if (
        rawState.includes('complete') ||
        rawState.includes('success') ||
        numberValue(raw, 'imported', 'saved', 'newGames') !== null
    ) {
        return 'completed';
    }
    return 'started';
}

function normalizeProviders(value: unknown): IncrementalSyncProviderResult[] {
    const entries: Array<[string, unknown]> = Array.isArray(value)
        ? value.map((item, index) => [
              isRecord(item) && typeof item.provider === 'string'
                  ? item.provider
                  : String(index),
              item,
          ])
        : isRecord(value)
          ? Object.entries(value)
          : [];

    return entries.flatMap(([key, item]) => {
        if (!isRecord(item)) return [];
        const rawProvider =
            stringValue(item, 'provider') ?? key.toLowerCase();
        const provider =
            rawProvider === 'LICHESS' || rawProvider.toLowerCase() === 'lichess'
                ? 'lichess'
                : rawProvider === 'CHESSCOM' ||
                    rawProvider.toLowerCase() === 'chesscom' ||
                    rawProvider.toLowerCase() === 'chess.com'
                  ? 'chesscom'
                  : null;
        if (!provider) return [];
        const state = normalizeProviderState(item);
        return [
            {
                provider,
                state,
                imported: numberValue(item, 'imported', 'saved', 'newGames'),
                error: stringValue(item, 'error', 'message'),
                jobId: stringValue(item, 'jobId'),
                skippedReason: stringValue(item, 'skippedReason', 'reason'),
                accepted:
                    item.queued === true ||
                    state === 'awaiting-worker' ||
                    state === 'already-running',
            },
        ];
    });
}

export function parseIncrementalSyncResponse(
    value: unknown,
    ok: boolean
): IncrementalSyncResult {
    const record = isRecord(value) ? value : {};
    const providers = normalizeProviders(
        record.providers ?? record.results ?? record.providerResults
    );
    const rawState = (
        stringValue(record, 'state', 'status', 'result') ?? ''
    ).toLowerCase();
    const explicitMessage = stringValue(record, 'message');
    const failedCount = providers.filter(
        (provider) => provider.state === 'failed'
    ).length;
    const runningCount = providers.filter(
        (provider) => provider.state === 'already-running'
    ).length;
    const awaitingWorkerCount = providers.filter(
        (provider) => provider.state === 'awaiting-worker'
    ).length;
    const freshCount = providers.filter(
        (provider) => provider.state === 'up-to-date'
    ).length;

    let state: IncrementalSyncResult['state'];
    if (
        !ok ||
        rawState.includes('fail') ||
        rawState.includes('error') ||
        (providers.length > 0 && failedCount === providers.length)
    ) {
        state = failedCount > 0 && failedCount < providers.length
            ? 'partial'
            : 'failed';
    } else if (
        rawState.includes('partial') ||
        (failedCount > 0 && failedCount < providers.length)
    ) {
        state = 'partial';
    } else if (awaitingWorkerCount > 0) {
        state = 'awaiting-worker';
    } else if (
        rawState.includes('already') ||
        rawState.includes('running') ||
        (providers.length > 0 && runningCount === providers.length)
    ) {
        state = 'already-running';
    } else if (
        rawState.includes('fresh') ||
        rawState.includes('up_to_date') ||
        rawState.includes('up-to-date') ||
        (providers.length > 0 && freshCount === providers.length)
    ) {
        state = 'up-to-date';
    } else {
        state = 'started';
    }

    const imported = providers.reduce(
        (total, provider) => total + (provider.imported ?? 0),
        0
    );
    const message =
        (awaitingWorkerCount > 0
            ? awaitingWorkerCount === providers.length
                ? 'Sync is queued, but the background worker could not be notified yet. Retry Sync now.'
                : 'One source is queued, but the background worker could not be notified yet. Retry Sync now.'
            : null) ??
        explicitMessage ??
        (state === 'failed'
            ? stringValue(record, 'error') ?? 'Sync could not be started.'
            : state === 'partial'
              ? 'Some sources synced; another source needs attention.'
              : state === 'already-running'
                ? 'A sync is already running.'
                : state === 'up-to-date'
                  ? 'Your linked sources are already up to date.'
                  : imported > 0
                    ? `${imported} new game${imported === 1 ? '' : 's'} imported.`
                    : 'Sync started in the background.');

    return {
        state,
        providers,
        message,
        activity: isUserSyncActivity(record.active)
            ? record.active
            : null,
    };
}

export async function requestIncrementalSync(
    options: RequestIncrementalSyncOptions = {}
): Promise<IncrementalSyncResult> {
    const body = await requestGameSync(options);
    return parseIncrementalSyncResponse(body, true);
}

export type SyncCompletionObservation = {
    complete: boolean;
    jobs: SyncJobActivity[];
    missingJobIds: string[];
    failed: number;
    cancelled: number;
    succeeded: number;
    createdCount: number;
};

export type SyncCompletionResult = SyncCompletionObservation & {
    timedOut: boolean;
    activity: UserSyncActivity | null;
};

const TERMINAL_SYNC_JOB_STATUSES = new Set([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
]);

export function observeIncrementalSyncJobs(
    activity: UserSyncActivity,
    jobIds: string[]
): SyncCompletionObservation {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))];
    const requestedJobIds = new Set(uniqueJobIds);
    const byId = new Map<string, SyncJobActivity>();
    for (const job of activity.requestedJobs ?? []) {
        if (requestedJobIds.has(job.id)) byId.set(job.id, job);
    }
    for (const provider of activity.providers) {
        for (const job of [provider.activeJob, provider.latestJob]) {
            if (job && requestedJobIds.has(job.id)) byId.set(job.id, job);
        }
    }
    const jobs = uniqueJobIds.flatMap((id) => {
        const job = byId.get(id);
        return job ? [job] : [];
    });
    const missingJobIds = uniqueJobIds.filter((id) => !byId.has(id));
    return {
        complete:
            uniqueJobIds.length > 0 &&
            missingJobIds.length === 0 &&
            jobs.every((job) =>
                TERMINAL_SYNC_JOB_STATUSES.has(job.status)
            ),
        jobs,
        missingJobIds,
        failed: jobs.filter((job) => job.status === 'FAILED').length,
        cancelled: jobs.filter((job) => job.status === 'CANCELLED').length,
        succeeded: jobs.filter((job) => job.status === 'SUCCEEDED').length,
        createdCount: jobs.reduce(
            (total, job) => total + Math.max(0, job.createdCount),
            0
        ),
    };
}

function abortError() {
    const error = new Error('Sync observation cancelled');
    error.name = 'AbortError';
    return error;
}

function waitForDelay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(abortError());
        };
        const timer = window.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export async function waitForIncrementalSyncJobs(args: {
    jobIds: string[];
    initialActivity?: UserSyncActivity | null;
    signal?: AbortSignal;
    maxAttempts?: number;
    fetchActivity?: () => Promise<UserSyncActivity>;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<SyncCompletionResult> {
    const jobIds = [...new Set(args.jobIds.filter(Boolean))];
    if (jobIds.length === 0) {
        return {
            complete: true,
            jobs: [],
            missingJobIds: [],
            failed: 0,
            cancelled: 0,
            succeeded: 0,
            createdCount: 0,
            timedOut: false,
            activity: args.initialActivity ?? null,
        };
    }

    const maxAttempts = Math.max(1, Math.min(args.maxAttempts ?? 12, 30));
    const fetchActivity =
        args.fetchActivity ?? (() => getGameSyncActivity(jobIds));
    const wait = args.wait ?? waitForDelay;
    let activity = args.initialActivity ?? null;
    let observation = activity
        ? observeIncrementalSyncJobs(activity, jobIds)
        : null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (args.signal?.aborted) throw abortError();
        if (observation?.complete) {
            return { ...observation, timedOut: false, activity };
        }
        if (attempt > 0 || activity !== null) {
            const delay = Math.min(
                5_000,
                Math.round(500 * 1.65 ** attempt)
            );
            await wait(delay, args.signal);
        }
        if (args.signal?.aborted) throw abortError();
        try {
            activity = await fetchActivity();
            observation = observeIncrementalSyncJobs(activity, jobIds);
        } catch (error) {
            if (args.signal?.aborted) throw abortError();
            if (attempt === maxAttempts - 1) throw error;
        }
    }

    if (observation?.complete) {
        return { ...observation, timedOut: false, activity };
    }
    return {
        ...(observation ?? {
            complete: false,
            jobs: [],
            missingJobIds: jobIds,
            failed: 0,
            cancelled: 0,
            succeeded: 0,
            createdCount: 0,
        }),
        timedOut: true,
        activity,
    };
}

export function publishChessConnectionsChanged(detail: {
    ownerId: string;
    provider: SyncProvider;
    username: string | null;
}) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
        new CustomEvent(CHESS_CONNECTIONS_CHANGED_EVENT, { detail })
    );
}

export function humanizeAutomationBlockReason(
    reason: string | null | undefined
) {
    if (!reason) return null;
    if (reason === 'disabled') return 'Automatic server analysis is off.';
    if (reason === 'credits') return 'No server credits are available.';
    if (reason === 'reserve') {
        return 'Your credit reserve has been reached.';
    }
    if (reason === 'daily-cap') {
        return 'Your automatic-analysis daily cap has been reached.';
    }
    if (reason === 'monthly-cap') {
        return 'Your automatic-analysis monthly cap has been reached.';
    }
    if (reason === 'plan-cap') {
        return 'Your plan’s monthly analysis limit has been reached.';
    }
    return reason;
}

export type AutomationBlockAction = {
    label: string;
    href: string;
};

export function automationBlockAction(
    reason: string | null | undefined
): AutomationBlockAction {
    if (reason === 'credits') {
        return { label: 'Get credits', href: '/settings#billing' };
    }
    if (reason === 'plan-cap') {
        return { label: 'Review plan', href: '/settings#billing' };
    }
    return {
        label: 'Manage automation',
        href: '/settings#automatic-analysis',
    };
}

export function isCreditOrCapBlockReason(
    reason: string | null | undefined
) {
    return (
        reason === 'credits' ||
        reason === 'reserve' ||
        reason === 'daily-cap' ||
        reason === 'monthly-cap' ||
        reason === 'plan-cap'
    );
}

function isUserSyncActivity(value: unknown): value is UserSyncActivity {
    return (
        isRecord(value) &&
        Array.isArray(value.providers)
    );
}

export function mostRecentProviderActivity(
    isoValues: Array<string | null | undefined>
): string | null {
    let latest: string | null = null;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const value of isoValues) {
        if (!value) continue;
        const timestamp = new Date(value).getTime();
        if (Number.isNaN(timestamp) || timestamp <= latestMs) continue;
        latest = value;
        latestMs = timestamp;
    }
    return latest;
}

export function formatSyncTime(value: string | null, now = Date.now()) {
    if (!value) return 'Never synced';
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) return 'Sync time unavailable';
    const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
    if (minutes < 1) return 'Synced just now';
    if (minutes < 60) return `Synced ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Synced ${hours}h ago`;
    return `Synced ${Math.floor(hours / 24)}d ago`;
}
