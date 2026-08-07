'use server';

import { redirect } from 'next/navigation';

import { requireAdminSession } from '@/lib/auth/admin';
import {
    createAndSendPremiumInvitation,
    PremiumInvitationError,
    revokePlanGrant,
    revokePremiumInvitation,
} from '@/lib/premium/invitations';

const PREMIUM_ADMIN_PATH = '/admin/premium';

export async function invitePremiumAction(formData: FormData) {
    const admin = await requireAdminSession('PREMIUM_MANAGE');
    const email = String(formData.get('email') ?? '');
    try {
        await createAndSendPremiumInvitation({
            invitedById: admin.userId,
            adminMembershipId: admin.membershipId,
            email,
            auditAction: 'PREMIUM_INVITATION_CREATE',
        });
    } catch (error) {
        redirectWithError(error);
    }
    redirect(`${PREMIUM_ADMIN_PATH}?notice=invitation-sent`);
}

export async function resendPremiumInvitationAction(formData: FormData) {
    const admin = await requireAdminSession('PREMIUM_MANAGE');
    const email = String(formData.get('email') ?? '');
    try {
        await createAndSendPremiumInvitation({
            invitedById: admin.userId,
            adminMembershipId: admin.membershipId,
            email,
            auditAction: 'PREMIUM_INVITATION_RESEND',
        });
    } catch (error) {
        redirectWithError(error);
    }
    redirect(`${PREMIUM_ADMIN_PATH}?notice=invitation-resent`);
}

export async function revokePremiumInvitationAction(formData: FormData) {
    const admin = await requireAdminSession('PREMIUM_MANAGE');
    try {
        await revokePremiumInvitation({
            invitationId: String(formData.get('invitationId') ?? ''),
            adminMembershipId: admin.membershipId,
        });
    } catch (error) {
        redirectWithError(error);
    }
    redirect(`${PREMIUM_ADMIN_PATH}?notice=invitation-revoked`);
}

export async function revokePlanGrantAction(formData: FormData) {
    const admin = await requireAdminSession('PREMIUM_MANAGE');
    try {
        await revokePlanGrant({
            grantId: String(formData.get('grantId') ?? ''),
            revokedById: admin.userId,
            adminMembershipId: admin.membershipId,
        });
    } catch (error) {
        redirectWithError(error);
    }
    redirect(`${PREMIUM_ADMIN_PATH}?notice=access-revoked`);
}

function redirectWithError(error: unknown): never {
    if (!(error instanceof PremiumInvitationError)) {
        console.error('[admin premium] action failed', error);
    }
    const message =
        error instanceof PremiumInvitationError
            ? error.message
            : 'The premium action could not be completed';
    redirect(`${PREMIUM_ADMIN_PATH}?error=${encodeURIComponent(message)}`);
}
