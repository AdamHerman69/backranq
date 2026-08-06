import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    auditMock,
    createRunMock,
    publishRunMock,
    publishCandidateMock,
    slotUpsertMock,
    slotFindMock,
    overrideCreateMock,
} = vi.hoisted(() => ({
    auditMock: vi.fn(),
    createRunMock: vi.fn(),
    publishRunMock: vi.fn(),
    publishCandidateMock: vi.fn(),
    slotUpsertMock: vi.fn(),
    slotFindMock: vi.fn(),
    overrideCreateMock: vi.fn(),
}));

const tx = {
    masterSlot: {
        upsert: slotUpsertMock,
        findUniqueOrThrow: slotFindMock,
    },
    masterAdminOverride: {
        create: overrideCreateMock,
    },
};

vi.mock('@/lib/admin/audit', () => ({
    runAuditedAdminMutation: auditMock,
}));
vi.mock('@/lib/master/pipeline', () => ({
    createMasterPipelineRun: createRunMock,
    publishMasterPipelineRun: publishRunMock,
}));
vi.mock('@/lib/master/publication', () => ({
    publishMasterCandidate: publishCandidateMock,
}));

import { executeMasterAdminCommand } from '@/lib/master/adminCommandService';

const context = {
    principal: {
        membershipId: 'membership-1',
        userId: 'user-1',
        role: 'ADMIN' as const,
        capabilities: [] as const,
    },
    idempotencyKey: 'admin-command-0001',
    requestId: 'request-1',
    ipHash: null,
    userAgentHash: null,
};

describe('Weekly Master admin command adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        auditMock.mockImplementation(async (args) => ({
            result: await args.mutate(tx),
            replayed: false,
        }));
        createRunMock.mockResolvedValue({ id: 'run-1', status: 'QUEUED' });
        publishRunMock.mockResolvedValue({ queued: true, messageId: 'message-1' });
        publishCandidateMock.mockResolvedValue({ id: 'publication-1' });
        slotFindMock.mockResolvedValue({ id: 'slot-1' });
        slotUpsertMock.mockResolvedValue({ id: 'slot-1' });
        overrideCreateMock.mockResolvedValue({ id: 'override-1' });
    });

    it('creates the force run inside the audited transaction and wakes it afterward', async () => {
        const receipt = await executeMasterAdminCommand({
            context,
            command: {
                type: 'FORCE_PIPELINE',
                scope: 'INGEST',
                reason: 'Provider recovered',
            },
        });

        expect(createRunMock).toHaveBeenCalledWith(tx, {
            trigger: 'ADMIN',
            scope: 'INGEST',
            runKey: 'weekly-master:admin:admin-command-0001',
        });
        expect(publishRunMock).toHaveBeenCalledWith('run-1');
        expect(receipt.result).toMatchObject({
            runId: 'run-1',
            status: 'QUEUED',
        });
    });

    it('targets one explicit source game for a forced analysis run', async () => {
        await executeMasterAdminCommand({
            context,
            command: {
                type: 'ANALYZE_SOURCE_GAME',
                sourceGameId: '123e4567-e89b-42d3-a456-426614174000',
                reason: 'Inspect this fresh game before publication',
            },
        });

        expect(createRunMock).toHaveBeenCalledWith(tx, {
            trigger: 'ADMIN',
            scope: 'ANALYSIS',
            runKey: 'weekly-master:admin:admin-command-0001',
            targetSourceGameId: '123e4567-e89b-42d3-a456-426614174000',
        });
        expect(publishRunMock).toHaveBeenCalledWith('run-1');
    });

    it('publishes a selected candidate and atomically pins it with an expiry', async () => {
        const expiresAt = '2026-08-13T10:00:00.000Z';
        const receipt = await executeMasterAdminCommand({
            context,
            command: {
                type: 'SELECT_CANDIDATE',
                candidateId: '123e4567-e89b-42d3-a456-426614174000',
                slotKey: 'landing-weekly-master',
                expiresAt,
                reason: 'Best verified onboarding position this week',
            },
        });

        expect(publishCandidateMock).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                candidateId: '123e4567-e89b-42d3-a456-426614174000',
                slotKey: 'landing-weekly-master',
            })
        );
        expect(overrideCreateMock).toHaveBeenCalledWith({
            data: expect.objectContaining({
                kind: 'PIN_PUBLICATION',
                slotId: 'slot-1',
                targetPublicationId: 'publication-1',
                createdByAdminId: 'membership-1',
                expiresAt: new Date(expiresAt),
            }),
            select: { id: true },
        });
        expect(receipt.result).toMatchObject({
            targetId: 'publication-1',
            status: 'PUBLISHED_AND_PINNED',
        });
    });

    it('scopes a temporary automation pause to the landing slot', async () => {
        await executeMasterAdminCommand({
            context,
            command: {
                type: 'PAUSE_AUTOMATION',
                expiresAt: '2026-08-07T10:00:00.000Z',
                reason: 'Investigating provider failures',
            },
        });

        expect(slotUpsertMock).toHaveBeenCalledWith({
            where: { key: 'landing-weekly-master' },
            create: { key: 'landing-weekly-master' },
            update: {},
            select: { id: true },
        });
        expect(overrideCreateMock).toHaveBeenCalledWith({
            data: expect.objectContaining({
                kind: 'PAUSE_AUTOMATION',
                slotId: 'slot-1',
            }),
            select: { id: true },
        });
    });
});
