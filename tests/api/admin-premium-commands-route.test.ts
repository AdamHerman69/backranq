import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { createJsonRequest, readJson } from '../helpers/route';

const { requireMutationMock, executeCommandMock, ConflictError, InvitationError } =
    vi.hoisted(() => ({
        requireMutationMock: vi.fn(),
        executeCommandMock: vi.fn(),
        ConflictError: class PremiumAdminCommandConflict extends Error {},
        InvitationError: class PremiumInvitationError extends Error {},
    }));

vi.mock('@/lib/admin/http', () => ({
    ADMIN_MUTATION_MAX_BYTES: 32_000,
    requireAdminMutation: requireMutationMock,
    isAdminApiResponse: (value: unknown) => value instanceof NextResponse,
}));
vi.mock('@/lib/premium/adminCommandService', () => ({
    executePremiumAdminCommand: executeCommandMock,
    PremiumAdminCommandConflict: ConflictError,
}));
vi.mock('@/lib/premium/invitations', () => ({
    PremiumInvitationError: InvitationError,
}));

import { POST } from '@/app/api/admin/premium/commands/route';

const adminContext = {
    principal: {
        membershipId: 'membership-1',
        userId: 'user-1',
        role: 'ADMIN' as const,
        capabilities: ['PREMIUM_MANAGE'] as const,
    },
    idempotencyKey: 'membership-1:premium-command-0001',
    requestId: 'request-1',
    ipHash: null,
    userAgentHash: null,
};

function request(body: unknown) {
    return createJsonRequest(
        'https://backranq.test/api/admin/premium/commands',
        body,
        { method: 'POST' }
    );
}

describe('POST /api/admin/premium/commands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        requireMutationMock.mockResolvedValue(adminContext);
        executeCommandMock.mockResolvedValue({
            result: {
                command: 'CREATE_INVITATION',
                targetId: '11111111-1111-4111-8111-111111111111',
                invitationId: '11111111-1111-4111-8111-111111111111',
                grantId: null,
                deliveryGeneration: 1,
            },
            replayed: false,
            delivery: {
                invitationId: '11111111-1111-4111-8111-111111111111',
                generation: 1,
                status: 'SENT',
                attempted: true,
                message: null,
            },
        });
    });

    it('denies an editor before parsing or executing a Premium command', async () => {
        requireMutationMock.mockResolvedValue(
            NextResponse.json(
                { error: 'Forbidden', code: 'ADMIN_FORBIDDEN' },
                { status: 403 }
            )
        );

        const response = await POST(
            request({ type: 'CREATE_INVITATION', email: 'friend@example.com' })
        );

        expect(requireMutationMock).toHaveBeenCalledWith(
            expect.any(Request),
            'PREMIUM_MANAGE'
        );
        expect(response.status).toBe(403);
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('accepts a strict typed command and returns its idempotent receipt', async () => {
        const command = {
            type: 'RESEND_INVITATION',
            invitationId: '11111111-1111-4111-8111-111111111111',
        } as const;

        const response = await POST(request(command));

        expect(response.status).toBe(202);
        expect(executeCommandMock).toHaveBeenCalledWith({
            context: adminContext,
            command,
        });
        await expect(readJson(response)).resolves.toMatchObject({
            replayed: false,
            delivery: { status: 'SENT' },
        });
    });

    it('rejects unexpected fields and non-UUID resend targets', async () => {
        const response = await POST(
            request({
                type: 'RESEND_INVITATION',
                invitationId: 'not-an-id',
                email: 'attacker@example.com',
            })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'INVALID_PREMIUM_COMMAND',
        });
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('returns conflict without losing the typed error code', async () => {
        executeCommandMock.mockRejectedValue(
            new ConflictError('Invitation email delivery is in progress')
        );

        const response = await POST(
            request({
                type: 'REVOKE_INVITATION',
                invitationId: '11111111-1111-4111-8111-111111111111',
            })
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            code: 'PREMIUM_COMMAND_CONFLICT',
        });
    });
});
