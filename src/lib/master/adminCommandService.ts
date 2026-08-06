import type { Prisma } from '@prisma/client';

import { runAuditedAdminMutation } from '@/lib/admin/audit';
import type { AdminMutationContext } from '@/lib/admin/http';
import type { MasterAdminCommand } from '@/lib/master/adminContracts';
import { WEEKLY_MASTER_SLOT_KEY } from '@/lib/master/config';
import {
    createMasterPipelineRun,
    MasterPipelineBusyError,
    publishMasterPipelineRun,
} from '@/lib/master/pipeline';
import { publishMasterCandidate } from '@/lib/master/publication';

export type MasterAdminCommandResult = {
    command: MasterAdminCommand['type'];
    targetId: string | null;
    runId?: string;
    overrideId?: string;
    status: string;
};

function targetFor(command: MasterAdminCommand): {
    type: string;
    id: string | null;
} {
    switch (command.type) {
        case 'FORCE_PIPELINE':
            return { type: 'MasterPipelineRun', id: null };
        case 'ANALYZE_SOURCE_GAME':
            return { type: 'MasterSourceGame', id: command.sourceGameId };
        case 'APPROVE_CANDIDATE':
        case 'EXCLUDE_CANDIDATE':
        case 'SELECT_CANDIDATE':
            return { type: 'MasterCandidate', id: command.candidateId };
        case 'PIN_PUBLICATION':
        case 'WITHDRAW_PUBLICATION':
            return { type: 'MasterPublication', id: command.publicationId };
        case 'FORCE_FALLBACK':
            return { type: 'MasterSlot', id: command.slotKey };
        case 'PAUSE_AUTOMATION':
            return { type: 'MasterPipeline', id: null };
        case 'EXCLUDE_PERSON':
            return { type: 'MasterPerson', id: command.personId };
        case 'EXCLUDE_ACCOUNT':
            return { type: 'MasterAccount', id: command.accountId };
        case 'REVOKE_OVERRIDE':
            return { type: 'MasterAdminOverride', id: command.overrideId };
    }
}

async function createOverride(
    tx: Prisma.TransactionClient,
    args: {
        command: Exclude<
            MasterAdminCommand,
            | { type: 'FORCE_PIPELINE' }
            | { type: 'ANALYZE_SOURCE_GAME' }
            | { type: 'APPROVE_CANDIDATE' }
            | { type: 'EXCLUDE_CANDIDATE' }
            | { type: 'SELECT_CANDIDATE' }
            | { type: 'REVOKE_OVERRIDE' }
        >;
        adminMembershipId: string;
    }
): Promise<MasterAdminCommandResult> {
    const { command } = args;
    const slotKey =
        command.type === 'PIN_PUBLICATION' ||
        command.type === 'FORCE_FALLBACK'
            ? command.slotKey
            : command.type === 'PAUSE_AUTOMATION'
              ? WEEKLY_MASTER_SLOT_KEY
            : null;
    const slot = slotKey
        ? await tx.masterSlot.upsert({
              where: { key: slotKey },
              create: { key: slotKey },
              update: {},
              select: { id: true },
          })
        : null;

    const personId =
        command.type === 'EXCLUDE_PERSON' ? command.personId : null;
    const accountId =
        command.type === 'EXCLUDE_ACCOUNT' ? command.accountId : null;
    const scopedPublicationId =
        command.type === 'WITHDRAW_PUBLICATION'
            ? command.publicationId
            : null;
    const targetPublicationId =
        command.type === 'PIN_PUBLICATION' ? command.publicationId : null;

    if (personId) {
        const exists = await tx.masterPerson.findUnique({
            where: { id: personId },
            select: { id: true },
        });
        if (!exists) throw new AdminCommandConflict('Master person not found');
    }
    if (accountId) {
        const exists = await tx.masterAccount.findUnique({
            where: { id: accountId },
            select: { id: true },
        });
        if (!exists) throw new AdminCommandConflict('Master account not found');
    }
    if (scopedPublicationId || targetPublicationId) {
        const publicationId = scopedPublicationId ?? targetPublicationId;
        const exists = await tx.masterPublication.findUnique({
            where: { id: publicationId ?? '' },
            select: { id: true },
        });
        if (!exists) throw new AdminCommandConflict('Master publication not found');
    }

    const expiresAt = new Date(command.expiresAt);
    const override = await tx.masterAdminOverride.create({
        data: {
            kind: command.type,
            slotId: slot?.id ?? null,
            personId,
            accountId,
            publicationId: scopedPublicationId,
            targetPublicationId,
            expiresAt,
            reason: command.reason,
            createdByAdminId: args.adminMembershipId,
            metadata: {},
        },
        select: { id: true },
    });
    return {
        command: command.type,
        targetId:
            targetPublicationId ??
            scopedPublicationId ??
            personId ??
            accountId ??
            slot?.id ??
            null,
        overrideId: override.id,
        status: 'ACTIVE',
    };
}

export class AdminCommandConflict extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AdminCommandConflict';
    }
}

export class AdminCommandDispatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AdminCommandDispatchError';
    }
}

export async function executeMasterAdminCommand(args: {
    context: AdminMutationContext;
    command: MasterAdminCommand;
}): Promise<{ result: MasterAdminCommandResult; replayed: boolean }> {
    const target = targetFor(args.command);
    const receipt = await runAuditedAdminMutation({
        context: args.context,
        action: `WEEKLY_MASTER_${args.command.type}`,
        target,
        reason: args.command.reason,
        metadata: { command: args.command },
        mutate: async (tx) => {
            const command = args.command;
            switch (command.type) {
                case 'FORCE_PIPELINE': {
                    const run = await createAdminPipelineRun(tx, {
                        scope: command.scope,
                        runKey: `weekly-master:admin:${args.context.idempotencyKey}`,
                    });
                    return {
                        command: command.type,
                        targetId: run.id,
                        runId: run.id,
                        status: run.status,
                    };
                }
                case 'ANALYZE_SOURCE_GAME': {
                    const run = await createAdminPipelineRun(tx, {
                        scope: 'ANALYSIS',
                        runKey: `weekly-master:admin:${args.context.idempotencyKey}`,
                        targetSourceGameId: command.sourceGameId,
                    });
                    return {
                        command: command.type,
                        targetId: command.sourceGameId,
                        runId: run.id,
                        status: run.status,
                    };
                }
                case 'APPROVE_CANDIDATE':
                case 'EXCLUDE_CANDIDATE': {
                    const existing = await tx.masterCandidate.findUnique({
                        where: { id: command.candidateId },
                        select: {
                            id: true,
                            status: true,
                            hardGatePassed: true,
                            rejectionReasons: true,
                        },
                    });
                    if (!existing) {
                        throw new AdminCommandConflict('Master candidate not found');
                    }
                    if (command.type === 'APPROVE_CANDIDATE' && !existing.hardGatePassed) {
                        throw new AdminCommandConflict(
                            'A hard-gate failure cannot be selected manually'
                        );
                    }
                    if (existing.status === 'PUBLISHED') {
                        throw new AdminCommandConflict(
                            'Published candidates must be managed from their publication'
                        );
                    }
                    const status =
                        command.type === 'APPROVE_CANDIDATE'
                            ? 'ELIGIBLE'
                            : 'REJECTED';
                    await tx.masterCandidate.update({
                        where: { id: command.candidateId },
                        data: {
                            status,
                            rejectionReasons:
                                status === 'REJECTED'
                                    ? Array.from(
                                          new Set([
                                              ...existing.rejectionReasons,
                                              `EDITORIAL: ${command.reason}`,
                                          ])
                                      )
                                    : existing.rejectionReasons.filter(
                                          (reason) => !reason.startsWith('EDITORIAL: ')
                                      ),
                        },
                    });
                    return {
                        command: command.type,
                        targetId: command.candidateId,
                        status,
                    };
                }
                case 'SELECT_CANDIDATE': {
                    const now = new Date();
                    const publication = await publishMasterCandidate(tx, {
                        candidateId: command.candidateId,
                        slotKey: command.slotKey,
                        now,
                    });
                    const slot = await tx.masterSlot.findUniqueOrThrow({
                        where: { key: command.slotKey },
                        select: { id: true },
                    });
                    const override = await tx.masterAdminOverride.create({
                        data: {
                            kind: 'PIN_PUBLICATION',
                            slotId: slot.id,
                            targetPublicationId: publication.id,
                            expiresAt: new Date(command.expiresAt),
                            reason: command.reason,
                            createdByAdminId:
                                args.context.principal.membershipId,
                            metadata: {
                                selectedCandidateId: command.candidateId,
                            },
                        },
                        select: { id: true },
                    });
                    return {
                        command: command.type,
                        targetId: publication.id,
                        overrideId: override.id,
                        status: 'PUBLISHED_AND_PINNED',
                    };
                }
                case 'REVOKE_OVERRIDE': {
                    const result = await tx.masterAdminOverride.updateMany({
                        where: { id: command.overrideId, revokedAt: null },
                        data: {
                            revokedAt: new Date(),
                            revokedByAdminId:
                                args.context.principal.membershipId,
                            revokeReason: command.reason,
                        },
                    });
                    if (result.count !== 1) {
                        throw new AdminCommandConflict(
                            'Active master override not found'
                        );
                    }
                    return {
                        command: command.type,
                        targetId: command.overrideId,
                        overrideId: command.overrideId,
                        status: 'REVOKED',
                    };
                }
                default:
                    return createOverride(tx, {
                        command,
                        adminMembershipId:
                            args.context.principal.membershipId,
                    });
            }
        },
    });

    if (
        (args.command.type === 'FORCE_PIPELINE' ||
            args.command.type === 'ANALYZE_SOURCE_GAME') &&
        receipt.result.runId &&
        receipt.result.status === 'QUEUED'
    ) {
        try {
            await publishMasterPipelineRun(receipt.result.runId);
        } catch {
            throw new AdminCommandDispatchError(
                'Pipeline run is safely queued, but its worker wake-up failed; retry this command'
            );
        }
    }
    return receipt;
}

async function createAdminPipelineRun(
    tx: Prisma.TransactionClient,
    args: {
        scope: 'FULL' | 'INGEST' | 'ANALYSIS';
        runKey: string;
        targetSourceGameId?: string;
    }
) {
    try {
        return await createMasterPipelineRun(tx, {
            trigger: 'ADMIN',
            ...args,
        });
    } catch (error) {
        if (error instanceof MasterPipelineBusyError) {
            throw new AdminCommandConflict(
                `Pipeline run ${error.activeRunId} is already active; retry when it finishes`
            );
        }
        throw error;
    }
}
