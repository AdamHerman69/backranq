import { describe, expect, it } from 'vitest';

import { resolveCoachOfflineShellRevision } from '@/lib/coach/offlineRevision';

describe('coach offline shell revision', () => {
    it('changes with the immutable Vercel deployment commit', () => {
        expect(
            resolveCoachOfflineShellRevision({
                VERCEL_DEPLOYMENT_ID: 'deployment-a',
                VERCEL_GIT_COMMIT_SHA: 'commit-a',
            })
        ).toBe('deployment-a');
        expect(
            resolveCoachOfflineShellRevision({
                VERCEL_URL: 'backranq-deployment-b.vercel.app',
                VERCEL_GIT_COMMIT_SHA: 'commit-a',
            })
        ).toBe('backranq-deployment-b.vercel.app');
    });

    it('supports CI and explicit deterministic revisions', () => {
        expect(
            resolveCoachOfflineShellRevision({
                BACKRANQ_BUILD_REVISION: 'offline-v2',
                VERCEL_GIT_COMMIT_SHA: 'ignored',
            })
        ).toBe('offline-v2');
        expect(
            resolveCoachOfflineShellRevision({
                GITHUB_RUN_ID: '1234',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_SHA: 'github-commit',
            })
        ).toBe('1234-2');
        expect(resolveCoachOfflineShellRevision({})).toBe(
            'local-development'
        );
    });
});
