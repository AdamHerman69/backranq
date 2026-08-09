import Link from 'next/link';
import { ArrowLeft, CheckCircle2, CircleAlert, Gift, ShieldCheck } from 'lucide-react';
import { auth } from '@/lib/auth';
import { normalizeAccountEmail } from '@/lib/premium/invitations';
import { invitationPreview } from '@/lib/premium/invitations';
import { AdminSubmitButton } from '@/components/admin/AdminSubmitButton';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
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
    const matchingEmail = Boolean(
        invitation &&
        signedInEmail &&
        normalizeAccountEmail(signedInEmail) ===
            normalizeAccountEmail(invitation.email)
    );
    const accepted = Boolean(invitation?.acceptedAt);
    const acceptedForCurrentUser = accepted && matchingEmail;

    return (
        <div className="relative isolate flex min-h-[calc(100dvh-7rem)] items-center overflow-hidden py-8 sm:py-12">
            <div
                className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_hsl(var(--muted))_0,_transparent_48%)] opacity-90"
                aria-hidden="true"
            />
            <div className="mx-auto w-full max-w-xl">
                <Button asChild variant="ghost" className="mb-3 -ml-3 min-h-11">
                    <Link href="/">
                        <ArrowLeft aria-hidden="true" />
                        Back to Backranq
                    </Link>
                </Button>

                <Card className="overflow-hidden rounded-sm border-border/70 shadow-raised">
                    <div className="h-1.5 bg-accent" aria-hidden="true" />
                    <CardHeader className="pb-4 sm:p-8 sm:pb-5">
                        <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-sm bg-foreground text-background shadow-sm">
                            {invitation?.acceptedAt ? (
                                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                            ) : unavailable ? (
                                <CircleAlert className="h-5 w-5" aria-hidden="true" />
                            ) : (
                                <Gift className="h-5 w-5" aria-hidden="true" />
                            )}
                        </div>
                        <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.025em]">
                            {accepted
                                ? acceptedForCurrentUser
                                    ? 'Your Backranq Pro invitation is active'
                                    : 'This Backranq Pro invitation has been accepted'
                                : unavailable
                                  ? 'This invitation is no longer available'
                                  : 'You have been invited to Backranq Pro'}
                        </h1>
                        <CardDescription className="max-w-md leading-6">
                            Complimentary permanent Pro access for{' '}
                            {invitation
                                ? maskEmail(invitation.email)
                                : 'the invited account'}
                            . No payment method is required.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5 sm:px-8 sm:pb-8">
                        {query.error ? (
                            <div role="alert" className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                <p>{query.error}</p>
                            </div>
                        ) : null}

                        {!unavailable && !invitation?.acceptedAt ? (
                            <ol className="grid grid-cols-3 gap-2" aria-label="Invitation progress">
                                <InviteStep label="Invitation" complete />
                                <InviteStep label="Sign in" complete={Boolean(session?.user?.id)} />
                                <InviteStep label="Pro active" complete={false} />
                            </ol>
                        ) : null}

                        {acceptedForCurrentUser ? (
                            <div className="space-y-4">
                                <div className="flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4 text-sm">
                                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                                    <p>Your invitation has already been accepted. Pro access is ready on the invited account.</p>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <Button asChild className="min-h-11">
                                        <Link href="/practice">Start practicing</Link>
                                    </Button>
                                    <Button asChild variant="outline" className="min-h-11">
                                        <Link href="/settings#billing">View plan</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : accepted && !session?.user?.id ? (
                            <div className="space-y-4">
                                <div className="flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4 text-sm">
                                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                                    <p>
                                        This invitation has already been accepted. Sign in with the invited email to open the account where Pro is active.
                                    </p>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <Button asChild className="min-h-11">
                                        <Link href={`/login?callbackUrl=${encodeURIComponent(invitePath)}`}>
                                            Sign in to continue
                                        </Link>
                                    </Button>
                                    <Button asChild variant="outline" className="min-h-11">
                                        <Link href="/">Explore Backranq</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : accepted ? (
                            <div className="space-y-4">
                                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-sm leading-6">
                                    Pro is active on the invited account, but you are signed in as{' '}
                                    <span className="font-medium">{signedInEmail ?? 'an account without email'}</span>.
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <SignOutButton callbackUrl={invitePath} className="min-h-11">
                                        Switch account
                                    </SignOutButton>
                                    <Button asChild variant="ghost" className="min-h-11">
                                        <Link href="/support">Get help</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : unavailable ? (
                            <div className="space-y-4">
                                <p className="text-sm leading-6 text-muted-foreground">
                                    The link may be invalid, expired or revoked. Ask the sender for a fresh invitation, or contact us if you think this is a mistake.
                                </p>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <Button asChild className="min-h-11">
                                        <Link href="/support">Contact support</Link>
                                    </Button>
                                    <Button asChild variant="outline" className="min-h-11">
                                        <Link href="/">Explore Backranq</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : !session?.user?.id ? (
                            <div className="space-y-4">
                                <p className="text-sm leading-6 text-muted-foreground">
                                    Sign in with the invited email address. We will bring you straight back here to activate Pro.
                                </p>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <Button asChild className="min-h-11">
                                        <Link href={`/login?callbackUrl=${encodeURIComponent(invitePath)}`}>
                                            Sign in to accept
                                        </Link>
                                    </Button>
                                    <Button asChild variant="outline" className="min-h-11">
                                        <Link href="/">Not ready yet</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : !matchingEmail ? (
                            <div className="space-y-4">
                                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-sm leading-6">
                                    You are signed in as{' '}
                                    <span className="font-medium">{signedInEmail ?? 'an account without email'}</span>.
                                    Switch to the invited address to continue.
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <SignOutButton callbackUrl={invitePath} className="min-h-11">
                                        Switch account
                                    </SignOutButton>
                                    <Button asChild variant="ghost" className="min-h-11">
                                        <Link href="/support">Get help</Link>
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <p className="text-sm leading-6 text-muted-foreground">
                                    You are signed in with the invited account. Activate Pro now to unlock the complete training experience.
                                </p>
                                <form action={acceptPremiumInvitationAction}>
                                    <input type="hidden" name="token" value={token} />
                                    <AdminSubmitButton pendingLabel="Activating Pro…" className="min-h-11 w-full">
                                        Accept Pro invitation
                                    </AdminSubmitButton>
                                </form>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <nav aria-label="Invitation help" className="mt-5 flex justify-center gap-5 text-xs text-muted-foreground">
                    <Link className="hover:text-foreground" href="/privacy">Privacy</Link>
                    <Link className="hover:text-foreground" href="/terms">Terms</Link>
                    <Link className="hover:text-foreground" href="/support">Support</Link>
                </nav>
            </div>
        </div>
    );
}

function InviteStep({ label, complete }: { label: string; complete: boolean }) {
    return (
        <li className="min-w-0">
            <div className={`h-1.5 rounded-full ${complete ? 'bg-emerald-500' : 'bg-muted'}`} aria-hidden="true" />
            <div className={`mt-2 truncate text-[11px] ${complete ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                {label}
            </div>
        </li>
    );
}

function maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!local || !domain) return 'the invited email';
    return `${local.slice(0, 1)}${'*'.repeat(Math.min(4, Math.max(1, local.length - 1)))}@${domain}`;
}
