'use server';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
    acceptPremiumInvitation,
    PremiumInvitationError,
} from '@/lib/premium/invitations';

export async function acceptPremiumInvitationAction(formData: FormData) {
    const token = String(formData.get('token') ?? '');
    const invitePath = `/invite/${encodeURIComponent(token)}`;
    const session = await auth();
    if (!session?.user?.id) {
        redirect(`/login?callbackUrl=${encodeURIComponent(invitePath)}`);
    }
    try {
        await acceptPremiumInvitation({
            token,
            userId: session.user.id,
        });
    } catch (error) {
        const message =
            error instanceof PremiumInvitationError
                ? error.message
                : 'The invitation could not be accepted';
        redirect(`${invitePath}?error=${encodeURIComponent(message)}`);
    }
    redirect('/settings?premium=accepted');
}
