import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';

const requireAdminApiMock = vi.fn();
const requireAdminMutationMock = vi.fn();
const getSnapshotMock = vi.fn();
const executeCommandMock = vi.fn();
const roleHasCapabilityMock = vi.fn();

function adminPrincipal(role = 'ADMIN') {
    return {
        membershipId: 'membership-1',
        userId: 'user-1',
        role,
        capabilities: ['MASTER_VIEW'],
    };
}

async function importOverviewRoute() {
    vi.resetModules();
    vi.doMock('@/lib/admin/http', () => ({
        requireAdminApi: requireAdminApiMock,
        isAdminApiResponse: (value: unknown) => value instanceof Response,
    }));
    vi.doMock('@/lib/master/adminReadService', () => ({
        getWeeklyMasterAdminSnapshot: getSnapshotMock,
    }));
    return import('@/app/api/admin/weekly-master/overview/route');
}

async function importCommandRoute() {
    vi.resetModules();
    vi.doMock('@/lib/admin/http', () => ({
        ADMIN_MUTATION_MAX_BYTES: 32_000,
        requireAdminMutation: requireAdminMutationMock,
        isAdminApiResponse: (value: unknown) => value instanceof Response,
    }));
    vi.doMock('@/lib/auth/admin', () => ({
        roleHasCapability: roleHasCapabilityMock,
    }));
    vi.doMock('@/lib/master/adminCommandService', () => ({
        AdminCommandConflict: class AdminCommandConflict extends Error {},
        executeMasterAdminCommand: executeCommandMock,
    }));
    return import('@/app/api/admin/weekly-master/commands/route');
}

function commandRequest(body: unknown) {
    return new Request(
        'https://backranq.test/api/admin/weekly-master/commands',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }
    );
}

describe('Weekly Master admin API', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-06T10:00:00.000Z'));
        vi.clearAllMocks();
        requireAdminApiMock.mockResolvedValue(adminPrincipal());
        requireAdminMutationMock.mockResolvedValue({
            principal: adminPrincipal(),
            idempotencyKey: 'admin-test-key-0001',
            requestId: 'request-1',
            ipHash: null,
            userAgentHash: null,
        });
        roleHasCapabilityMock.mockReturnValue(true);
        getSnapshotMock.mockResolvedValue({
            generatedAt: '2026-08-06T10:00:00.000Z',
            stats: { users: 3 },
        });
        executeCommandMock.mockResolvedValue({
            result: {
                command: 'FORCE_PIPELINE',
                targetId: 'run-1',
                status: 'QUEUED',
            },
            replayed: false,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a private no-store control-room snapshot', async () => {
        const route = await importOverviewRoute();
        const response = await route.GET();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        await expect(readJson(response)).resolves.toMatchObject({
            principal: { role: 'ADMIN' },
            snapshot: { stats: { users: 3 } },
        });
        expect(requireAdminApiMock).toHaveBeenCalledWith('MASTER_VIEW');
    });

    it('rejects a malformed command before calling the mutation service', async () => {
        const route = await importCommandRoute();
        const response = await route.POST(
            commandRequest({ type: 'FORCE_PIPELINE', scope: 'ALL' })
        );

        expect(response.status).toBe(400);
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('checks the command-specific capability after parsing', async () => {
        roleHasCapabilityMock.mockReturnValue(false);
        const route = await importCommandRoute();
        const response = await route.POST(
            commandRequest({
                type: 'WITHDRAW_PUBLICATION',
                publicationId: '123e4567-e89b-42d3-a456-426614174000',
                expiresAt: '2026-08-20T10:00:00.000Z',
                reason: 'Source attribution needs review',
            })
        );

        expect(response.status).toBe(403);
        expect(roleHasCapabilityMock).toHaveBeenCalledWith(
            'ADMIN',
            'MASTER_PUBLISH'
        );
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('returns an accepted receipt for a valid idempotent wake-up', async () => {
        const route = await importCommandRoute();
        const response = await route.POST(
            commandRequest({
                type: 'FORCE_PIPELINE',
                scope: 'INGEST',
                reason: 'Provider recovered after an outage',
            })
        );

        expect(response.status).toBe(202);
        await expect(readJson(response)).resolves.toMatchObject({
            replayed: false,
            result: { status: 'QUEUED' },
        });
        expect(executeCommandMock).toHaveBeenCalledOnce();
    });
});
