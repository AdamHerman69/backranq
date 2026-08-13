import { describe, expect, it } from 'vitest';

import {
    automationBlockAction,
    formatSyncTime,
    humanizeAutomationBlockReason,
    isCreditOrCapBlockReason,
    mostRecentProviderActivity,
    observeIncrementalSyncJobs,
    parseIncrementalSyncResponse,
    waitForIncrementalSyncJobs,
} from '@/components/sync/syncClient';
import type {
    SyncJobActivity,
    UserSyncActivity,
} from '@/lib/services/gameSync';

describe('incremental sync client', () => {
    it('normalizes a newly queued background sync', () => {
        expect(
            parseIncrementalSyncResponse(
                {
                    requested: 2,
                    providers: [
                        {
                            provider: 'lichess',
                            queued: true,
                            jobStatus: 'QUEUED',
                            queuePublished: true,
                            jobId: 'job-1',
                            skippedReason: null,
                        },
                        {
                            provider: 'chesscom',
                            queued: true,
                            jobStatus: 'QUEUED',
                            queuePublished: true,
                            jobId: 'job-2',
                            skippedReason: null,
                        },
                    ],
                },
                true
            )
        ).toMatchObject({
            state: 'started',
            message: 'Sync started in the background.',
            providers: [
                {
                    provider: 'lichess',
                    state: 'started',
                    jobId: 'job-1',
                    accepted: true,
                },
                {
                    provider: 'chesscom',
                    state: 'started',
                    jobId: 'job-2',
                    accepted: true,
                },
            ],
        });
    });

    it('recognizes stale-guard and active-job skips without treating them as failures', () => {
        expect(
            parseIncrementalSyncResponse(
                {
                    providers: [
                        {
                            provider: 'lichess',
                            queued: false,
                            skippedReason: 'fresh',
                        },
                    ],
                },
                true
            ).state
        ).toBe('up-to-date');
        expect(
            parseIncrementalSyncResponse(
                {
                    providers: [
                        {
                            provider: 'chesscom',
                            queued: false,
                            skippedReason: 'already-queued',
                            jobStatus: 'RUNNING',
                        },
                    ],
                },
                true
            ).state
        ).toBe('already-running');
    });

    it('keeps an unnotified durable job retryable instead of claiming sync started', () => {
        expect(
            parseIncrementalSyncResponse(
                {
                    providers: [
                        {
                            provider: 'lichess',
                            queued: true,
                            queuePublished: false,
                            jobStatus: 'QUEUED',
                            jobId: 'job-1',
                        },
                    ],
                },
                true
            )
        ).toMatchObject({
            state: 'awaiting-worker',
            message:
                'Sync is queued, but the background worker could not be notified yet. Retry Sync now.',
            providers: [
                {
                    provider: 'lichess',
                    state: 'awaiting-worker',
                    accepted: true,
                },
            ],
        });

        expect(
            parseIncrementalSyncResponse(
                {
                    providers: [
                        {
                            provider: 'lichess',
                            queued: true,
                            queuePublished: true,
                            jobStatus: 'QUEUED',
                            jobId: 'job-1',
                        },
                        {
                            provider: 'chesscom',
                            queued: true,
                            queuePublished: false,
                            jobStatus: 'QUEUED',
                            jobId: 'job-2',
                        },
                    ],
                },
                true
            )
        ).toMatchObject({
            state: 'awaiting-worker',
            message:
                'One source is queued, but the background worker could not be notified yet. Retry Sync now.',
        });
    });

    it('surfaces partial provider failures', () => {
        expect(
            parseIncrementalSyncResponse(
                {
                    status: 'partial',
                    providers: [
                        {
                            provider: 'lichess',
                            status: 'started',
                        },
                        {
                            provider: 'chesscom',
                            status: 'failed',
                            error: 'rate limited',
                        },
                    ],
                },
                true
            )
        ).toMatchObject({
            state: 'partial',
            providers: [
                { provider: 'lichess', state: 'started' },
                {
                    provider: 'chesscom',
                    state: 'failed',
                    error: 'rate limited',
                },
            ],
        });
    });

    it('does not claim an unwoken joined durable sync job is running', () => {
        const result = parseIncrementalSyncResponse(
            {
                providers: [
                    {
                        provider: 'lichess',
                        queued: false,
                        queuePublished: false,
                        jobStatus: 'QUEUED',
                        skippedReason: 'already-queued',
                        jobId: 'job-waiting',
                    },
                    {
                        provider: 'chesscom',
                        queued: true,
                        queuePublished: true,
                        jobStatus: 'QUEUED',
                        jobId: 'job-started',
                    },
                ],
            },
            true
        );

        expect(result).toMatchObject({
            state: 'awaiting-worker',
            providers: [
                {
                    provider: 'lichess',
                    state: 'awaiting-worker',
                    accepted: true,
                },
                {
                    provider: 'chesscom',
                    state: 'started',
                    accepted: true,
                },
            ],
        });
        expect(result.message).toContain('worker could not be notified');
        expect(result.message).toContain('Retry Sync now');
    });

    it('uses the newest valid provider activity and formats recency', () => {
        const latest = mostRecentProviderActivity([
            '2026-07-29T08:00:00.000Z',
            null,
            '2026-07-29T09:00:00.000Z',
            'not-a-date',
        ]);
        expect(latest).toBe('2026-07-29T09:00:00.000Z');
        expect(
            formatSyncTime(
                latest,
                new Date('2026-07-29T09:45:00.000Z').getTime()
            )
        ).toBe('Synced 45m ago');
    });

    it('observes requested jobs until every job is terminal', async () => {
        const queued = syncActivity([
            syncJob('job-1', 'RUNNING'),
            syncJob('job-2', 'QUEUED'),
        ]);
        const completed = syncActivity([
            syncJob('job-1', 'SUCCEEDED', 2),
            syncJob('job-2', 'SUCCEEDED', 1),
        ]);

        expect(
            observeIncrementalSyncJobs(queued, ['job-1', 'job-2'])
        ).toMatchObject({ complete: false, createdCount: 0 });

        let reads = 0;
        const result = await waitForIncrementalSyncJobs({
            ownerId: 'user-1',
            jobIds: ['job-1', 'job-2'],
            initialActivity: queued,
            maxAttempts: 3,
            wait: async () => undefined,
            fetchActivity: async () => {
                reads += 1;
                return completed;
            },
        });
        expect(reads).toBe(1);
        expect(result).toMatchObject({
            complete: true,
            timedOut: false,
            succeeded: 2,
            createdCount: 3,
        });
    });

    it('observes a requested terminal job after a newer job displaced provider latest', () => {
        const activity = syncActivity([]);
        activity.requestedJobs = [
            syncJob('displaced-terminal-job', 'SUCCEEDED', 4),
        ];

        expect(
            observeIncrementalSyncJobs(activity, [
                'displaced-terminal-job',
            ])
        ).toMatchObject({
            complete: true,
            missingJobIds: [],
            succeeded: 1,
            createdCount: 4,
        });
    });

    it('stops polling after the bounded attempt budget', async () => {
        const running = syncActivity([syncJob('job-1', 'RUNNING')]);
        let reads = 0;
        const result = await waitForIncrementalSyncJobs({
            ownerId: 'user-1',
            jobIds: ['job-1'],
            initialActivity: running,
            maxAttempts: 2,
            wait: async () => undefined,
            fetchActivity: async () => {
                reads += 1;
                return running;
            },
        });
        expect(reads).toBe(2);
        expect(result).toMatchObject({
            complete: false,
            timedOut: true,
        });
    });

    it('rejects initial activity from another owner before polling', async () => {
        const activity = syncActivity([syncJob('job-1', 'RUNNING')]);
        activity.ownerId = 'user-b';
        const fetchActivity = async () => syncActivity([]);

        await expect(
            waitForIncrementalSyncJobs({
                ownerId: 'user-a',
                jobIds: ['job-1'],
                initialActivity: activity,
                fetchActivity,
            })
        ).rejects.toThrow('Invalid initial sync activity owner');
    });

    it('fails immediately when polling returns another owner', async () => {
        const fetchActivity = async () => {
            const activity = syncActivity([]);
            activity.ownerId = 'user-b';
            return activity;
        };

        await expect(
            waitForIncrementalSyncJobs({
                ownerId: 'user-a',
                jobIds: ['job-1'],
                maxAttempts: 3,
                wait: async () => undefined,
                fetchActivity,
            })
        ).rejects.toThrow('Invalid sync activity owner');
    });

    it('observes an exact requested terminal job after newer activity displaces it', () => {
        const requested = syncJob('job-old', 'SUCCEEDED', 4);
        const activity = syncActivity([syncJob('job-1', 'RUNNING')]);
        activity.requestedJobs = [requested];

        expect(
            observeIncrementalSyncJobs(activity, ['job-old'])
        ).toMatchObject({
            complete: true,
            missingJobIds: [],
            succeeded: 1,
            createdCount: 4,
        });
    });

    it('does not confuse disabled automation with a credit block', () => {
        expect(isCreditOrCapBlockReason('disabled')).toBe(false);
        expect(isCreditOrCapBlockReason('credits')).toBe(true);
        expect(humanizeAutomationBlockReason('disabled')).toBe(
            'Automatic server analysis is off.'
        );
        expect(humanizeAutomationBlockReason('daily-cap')).toContain(
            'daily cap'
        );
        expect(automationBlockAction('credits')).toEqual({
            label: 'Get credits',
            href: '/settings#billing',
        });
        expect(automationBlockAction('plan-cap')).toEqual({
            label: 'Review plan',
            href: '/settings#billing',
        });
        expect(automationBlockAction('reserve')).toEqual({
            label: 'Manage automation',
            href: '/settings#game-automation',
        });
    });
});

function syncJob(
    id: string,
    status: string,
    createdCount = 0
): SyncJobActivity {
    return {
        id,
        status,
        scheduledFor: '2026-07-29T00:00:00.000Z',
        startedAt: null,
        completedAt: status === 'SUCCEEDED'
            ? '2026-07-29T00:01:00.000Z'
            : null,
        fetchedCount: createdCount,
        savedCount: createdCount,
        createdCount,
        updatedCount: 0,
        queuedAnalysisCount: 0,
        lastError: null,
    };
}

function syncActivity(jobs: SyncJobActivity[]): UserSyncActivity {
    return {
        ownerId: 'user-1',
        providers: [
            {
                provider: 'LICHESS',
                linked: true,
                username: 'ada',
                state: null,
                activeJob:
                    jobs.find(
                        (job) =>
                            job.id === 'job-1' &&
                            (job.status === 'QUEUED' ||
                                job.status === 'RUNNING')
                    ) ?? null,
                latestJob:
                    jobs.find((job) => job.id === 'job-1') ?? null,
            },
            {
                provider: 'CHESSCOM',
                linked: true,
                username: 'ada',
                state: null,
                activeJob:
                    jobs.find(
                        (job) =>
                            job.id === 'job-2' &&
                            (job.status === 'QUEUED' ||
                                job.status === 'RUNNING')
                    ) ?? null,
                latestJob:
                    jobs.find((job) => job.id === 'job-2') ?? null,
            },
        ],
    };
}
