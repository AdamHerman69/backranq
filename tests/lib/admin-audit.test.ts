import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findReceiptMock, createAuditMock, transactionMock } = vi.hoisted(() => ({
    findReceiptMock: vi.fn(),
    createAuditMock: vi.fn(),
    transactionMock: vi.fn(),
}));

const tx = {
    adminAuditLog: { create: createAuditMock },
};

vi.mock('@/lib/prisma', () => ({
    prisma: {
        adminAuditLog: { findUnique: findReceiptMock },
        $transaction: transactionMock,
    },
}));

import { runAuditedAdminMutation } from '@/lib/admin/audit';

const context = {
    principal: {
        membershipId: 'membership-1',
        userId: 'user-1',
        role: 'ADMIN' as const,
        capabilities: [] as const,
    },
    idempotencyKey: 'admin-command-0001',
    requestId: 'request-1',
    ipHash: 'ip-hash',
    userAgentHash: 'ua-hash',
};

describe('admin audit receipt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findReceiptMock.mockResolvedValue(null);
        transactionMock.mockImplementation(
            async (callback: (client: typeof tx) => Promise<unknown>) =>
                callback(tx)
        );
        createAuditMock.mockResolvedValue({ id: 'audit-1' });
    });

    it('returns the original receipt without repeating a retried mutation', async () => {
        findReceiptMock.mockResolvedValue({
            metadata: {
                result: { status: 'ACTIVE', overrideId: 'override-1' },
            },
        });
        const mutate = vi.fn();

        const receipt = await runAuditedAdminMutation({
            context,
            action: 'WEEKLY_MASTER_PAUSE_AUTOMATION',
            target: { type: 'MasterPipeline' },
            reason: 'Provider incident',
            mutate,
        });

        expect(receipt).toEqual({
            replayed: true,
            result: { status: 'ACTIVE', overrideId: 'override-1' },
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(transactionMock).not.toHaveBeenCalled();
    });

    it('writes the mutation result and its audit record in one transaction', async () => {
        const mutate = vi.fn().mockResolvedValue({
            status: 'QUEUED',
            runId: 'run-1',
        });

        const receipt = await runAuditedAdminMutation({
            context,
            action: 'WEEKLY_MASTER_FORCE_PIPELINE',
            target: { type: 'MasterPipelineRun', id: 'run-1' },
            reason: 'Provider recovered',
            metadata: { scope: 'INGEST' },
            mutate,
        });

        expect(receipt).toEqual({
            replayed: false,
            result: { status: 'QUEUED', runId: 'run-1' },
        });
        expect(mutate).toHaveBeenCalledWith(tx);
        expect(createAuditMock).toHaveBeenCalledWith({
            data: expect.objectContaining({
                adminMembershipId: 'membership-1',
                idempotencyKey: 'admin-command-0001',
                requestId: 'request-1',
                reason: 'Provider recovered',
                metadata: expect.objectContaining({
                    ipHash: 'ip-hash',
                    userAgentHash: 'ua-hash',
                    result: { status: 'QUEUED', runId: 'run-1' },
                }),
            }),
        });
    });
});
