import { isRecord } from '@/lib/api/validation';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COMMAND_FIELDS: Record<PremiumAdminCommand['type'], readonly string[]> = {
    CREATE_INVITATION: ['type', 'email'],
    RESEND_INVITATION: ['type', 'invitationId'],
    REVOKE_INVITATION: ['type', 'invitationId'],
    REVOKE_GRANT: ['type', 'grantId'],
};

export type PremiumAdminCommand =
    | { type: 'CREATE_INVITATION'; email: string }
    | { type: 'RESEND_INVITATION'; invitationId: string }
    | { type: 'REVOKE_INVITATION'; invitationId: string }
    | { type: 'REVOKE_GRANT'; grantId: string };

export type PremiumAdminCommandResult = {
    command: PremiumAdminCommand['type'];
    commandFingerprint: string;
    targetId: string;
    invitationId: string | null;
    grantId: string | null;
    deliveryGeneration: number | null;
};

export type PremiumDeliveryResult = {
    invitationId: string;
    generation: number;
    status: 'PENDING' | 'SENDING' | 'SENT' | 'AMBIGUOUS' | 'FAILED';
    attempted: boolean;
    message: string | null;
};

export type PremiumAdminCommandReceipt = {
    result: PremiumAdminCommandResult;
    replayed: boolean;
    delivery: PremiumDeliveryResult | null;
};

export function parsePremiumAdminCommand(
    value: unknown
): { ok: true; value: PremiumAdminCommand } | { ok: false; error: string } {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return { ok: false, error: 'Expected a Premium admin command' };
    }
    if (!(value.type in COMMAND_FIELDS)) {
        return { ok: false, error: 'Unknown Premium admin command' };
    }

    const type = value.type as PremiumAdminCommand['type'];
    if (!hasOnlyFields(value, COMMAND_FIELDS[type])) {
        return { ok: false, error: 'Premium command contains unexpected fields' };
    }

    switch (type) {
        case 'CREATE_INVITATION':
            if (typeof value.email !== 'string') {
                return { ok: false, error: 'Invitation email is required' };
            }
            return { ok: true, value: { type, email: value.email } };
        case 'RESEND_INVITATION':
        case 'REVOKE_INVITATION':
            if (!isUuid(value.invitationId)) {
                return { ok: false, error: 'A valid invitation ID is required' };
            }
            return {
                ok: true,
                value: { type, invitationId: value.invitationId },
            };
        case 'REVOKE_GRANT':
            if (!isUuid(value.grantId)) {
                return { ok: false, error: 'A valid grant ID is required' };
            }
            return { ok: true, value: { type, grantId: value.grantId } };
    }
}

function hasOnlyFields(
    value: Record<string, unknown>,
    allowed: readonly string[]
) {
    const allowedFields = new Set(allowed);
    return Object.keys(value).every((field) => allowedFields.has(field));
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}
