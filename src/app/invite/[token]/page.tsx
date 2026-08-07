import Link from 'next/link';
import { CheckCircle2, Gift } from 'lucide-react';
import { auth } from '@/lib/auth';
import { normalizeAccountEmail } from '@/lib/premium/invitations';
import { invitationPreview } from '@/lib/premium/invitations';
import { AdminSubmitButton } from '@/components/admin/AdminSubmitButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { acceptPremiumInvitationAction } from './actions';

export default async function PremiumInvitationPage({
    params,
    searchParams,
}: {
    params: Promise<{ token: string }>;
    searchParams?: Promise<{ error?: string }>;
}) {
    const { token } = await params;
    const query = (await searchParams) ?? {};
    const [invitation, session] = await Promise.all([
        invitationPreview(token),
        auth(),
    ]);
    const now = new Date();
    const unavailable =
        !invitation ||
        invitation.revokedAt ||
        invitation.expiresAt <= now ||
        (!invitation.activeKey && !invitation.acceptedAt);
    const invitePath = `/invite/${encodeURIComponent(token)}`;
    const signedInEmail = session?.user?.email ?? null;
    const matchingEmail =
        invitation &&
        signedInEmail &&
        normalizeAccountEmail(signedInEmail) ===
            normalizeAccountEmail(invitation.email);

    return (
        <div className="mx-auto flex min-h-[70vh] max-w-lg items-center">
            <Card className="w-full">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        {invitation?.acceptedAt ? (
                            <CheckCircle2 className="h-5 w-5" />
                        ) : (
                            <Gift className="h-5 w-5" />
                        )}
                        Backranq Pro invitation
                    </CardTitle>
                    <CardDescription>
                        Complimentary permanent Pro access for {invitation ? maskEmail(invitation.email) : 'the invited account'}.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {query.error ? (
                        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                            {query.error}
                        </p>
                    ) : null}
                    {invitation?.acceptedAt ? (
                        <>
                            <p className="text-sm text-muted-foreground">This invitation has already been accepted.</p>
                            <Button asChild><Link href="/settings">Open Backranq</Link></Button>
                        </>
                    ) : unavailable ? (
                        <p className="text-sm text-muted-foreground">This invitation is invalid, expired, or was revoked. Ask the sender for a new invitation.</p>
                    ) : !session?.user?.id ? (
                        <>
                            <p className="text-sm text-muted-foreground">Sign in using the invited email address, then return here to accept Pro.</p>
                            <Button asChild>
                                <Link href={`/login?callbackUrl=${encodeURIComponent(invitePath)}`}>Sign in to accept</Link>
                            </Button>
                        </>
                    ) : !matchingEmail ? (
                        <p className="text-sm text-muted-foreground">
                            You are signed in as {signedInEmail ?? 'an account without email'}. Sign out and use the invited email address.
                        </p>
                    ) : (
                        <>
                            <p className="text-sm text-muted-foreground">Accepting unlocks Pro immediately. No payment method is required.</p>
                            <form action={acceptPremiumInvitationAction}>
                                <input type="hidden" name="token" value={token} />
                                <AdminSubmitButton pendingLabel="Activating Pro…">Accept Pro invitation</AdminSubmitButton>
                            </form>
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

function maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!local || !domain) return 'the invited email';
    return `${local.slice(0, 1)}${'*'.repeat(Math.min(4, Math.max(1, local.length - 1)))}@${domain}`;
}
