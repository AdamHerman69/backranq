import type { Prisma } from '@prisma/client';

import { isRecord } from '@/lib/api/validation';
import type { AdminMutationContext } from '@/lib/admin/http';
import { prisma } from '@/lib/prisma';

export type AdminAuditTarget = {
    type: string;
    id?: string | null;
};

type AuditedResult<T> = {
    result: T;
    replayed: boolean;
};

function replayedResult<T>(metadata: unknown): T | null {
    if (!isRecord(metadata) || !('result' in metadata)) return null;
    return metadata.result as T;
}

/**
 * Executes an admin mutation and its audit record in one database transaction.
 * The audit idempotency key is also the command receipt, so a browser retry can
 * safely receive the original result without repeating the mutation.
 */
export async function runAuditedAdminMutation<T>(args: {
    context: AdminMutationContext;
    action: string;
    target: AdminAuditTarget;
    reason: string;
    metadata?: Record<string, unknown>;
    mutate: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<AuditedResult<T>> {
    const existing = await prisma.adminAuditLog.findUnique({
        where: { idempotencyKey: args.context.idempotencyKey },
        select: { metadata: true },
    });
    if (existing) {
        const result = replayedResult<T>(existing.metadata);
        if (result === null) {
            throw new Error('Admin command receipt is missing its result');
        }
        return { result, replayed: true };
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const mutationResult = await args.mutate(tx);
            await tx.adminAuditLog.create({
                data: {
                    adminMembershipId:
                        args.context.principal.membershipId,
                    idempotencyKey: args.context.idempotencyKey,
                    action: args.action,
                    targetType: args.target.type,
                    targetId: args.target.id ?? null,
                    requestId: args.context.requestId,
                    reason: args.reason,
                    metadata: {
                        ...args.metadata,
                        ipHash: args.context.ipHash,
                        userAgentHash: args.context.userAgentHash,
                        result: mutationResult,
                    } as Prisma.InputJsonValue,
                },
            });
            return mutationResult;
        });
        return { result, replayed: false };
    } catch (error) {
        if (
            isRecord(error) &&
            error.code === 'P2002'
        ) {
            const receipt = await prisma.adminAuditLog.findUnique({
                where: { idempotencyKey: args.context.idempotencyKey },
                select: { metadata: true },
            });
            const result = replayedResult<T>(receipt?.metadata);
            if (result !== null) return { result, replayed: true };
        }
        throw error;
    }
}
