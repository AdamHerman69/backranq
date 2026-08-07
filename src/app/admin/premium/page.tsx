import { Gift, Mail, ShieldCheck } from 'lucide-react';

import { AdminSubmitButton } from '@/components/admin/AdminSubmitButton';
import { PageHeader } from '@/components/app/PageHeader';
import { Badge } from '@/components/ui/badge';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { requireAdminSession } from '@/lib/auth/admin';
import { prisma } from '@/lib/prisma';

import {
    invitePremiumAction,
    resendPremiumInvitationAction,
    revokePlanGrantAction,
    revokePremiumInvitationAction,
} from './actions';

const NOTICES: Record<string, string> = {
    'invitation-sent': 'The Pro invitation was sent.',
    'invitation-resent': 'A fresh invitation link was sent.',
    'invitation-revoked': 'The pending invitation was revoked.',
    'access-revoked': 'Complimentary Pro access was revoked.',
};

export const dynamic = 'force-dynamic';

export default async function PremiumAdminPage({
    searchParams,
}: {
    searchParams?: Promise<{ notice?: string; error?: string }>;
}) {
    await requireAdminSession('PREMIUM_MANAGE');

    const now = new Date();
    const [invitations, grants, query] = await Promise.all([
        prisma.premiumInvitation.findMany({
            where: {
                activeKey: { not: null },
                acceptedAt: null,
                revokedAt: null,
            },
            orderBy: { updatedAt: 'desc' },
            take: 50,
        }),
        prisma.planGrant.findMany({
            where: {
                revokedAt: null,
                startsAt: { lte: now },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            include: {
                user: { select: { email: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        }),
        searchParams ??
            Promise.resolve<{ notice?: string; error?: string }>({}),
    ]);
    const notice = query.notice ? NOTICES[query.notice] : null;
    const emailConfigured = Boolean(
        process.env.SMTP2GO_API_KEY && process.env.BACKRANQ_EMAIL_FROM
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Premium"
                subtitle="Invite people to complimentary Backranq Pro and manage active access."
            />

            {notice ? (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    {notice}
                </p>
            ) : null}
            {query.error ? (
                <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                >
                    {query.error}
                </p>
            ) : null}
            {!emailConfigured ? (
                <p
                    role="alert"
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
                >
                    Invitation email is not configured. Set SMTP2GO_API_KEY and
                    BACKRANQ_EMAIL_FROM before sending.
                </p>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Mail className="h-4 w-4" />
                            Invite to Pro
                        </CardTitle>
                        <CardDescription>
                            Enter one email. The recipient gets a 14-day,
                            single-use link that grants complimentary Pro after
                            they sign in with the invited address.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form
                            action={invitePremiumAction}
                            className="flex flex-col gap-3 sm:flex-row"
                        >
                            <Input
                                type="email"
                                name="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                                placeholder="friend@example.com"
                                aria-label="Invitation email"
                            />
                            <AdminSubmitButton
                                pendingLabel="Sending…"
                                disabled={!emailConfigured}
                            >
                                Send invitation
                            </AdminSubmitButton>
                        </form>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <ShieldCheck className="h-4 w-4" />
                            Administrator access
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Active database-backed administrators receive Pro
                        automatically. No invitation or Stripe subscription is
                        required.
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">
                        Pending invitations
                    </CardTitle>
                    <CardDescription>
                        Resending rotates the token and invalidates the previous
                        link.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {invitations.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No invitations are pending.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Email</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Expires</TableHead>
                                        <TableHead className="text-right">
                                            Actions
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {invitations.map((invitation) => {
                                        const expired =
                                            invitation.expiresAt <= now;
                                        const status = invitation.lastEmailError
                                            ? 'Email issue'
                                            : invitation.emailSentAt
                                              ? 'Sent'
                                              : 'Pending';
                                        return (
                                            <TableRow key={invitation.id}>
                                                <TableCell className="font-medium">
                                                    {invitation.email}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant={
                                                            invitation.lastEmailError
                                                                ? 'destructive'
                                                                : 'secondary'
                                                        }
                                                    >
                                                        {expired
                                                            ? 'Expired'
                                                            : status}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    {invitation.expiresAt.toLocaleDateString()}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex justify-end gap-2">
                                                        <form
                                                            action={
                                                                resendPremiumInvitationAction
                                                            }
                                                        >
                                                            <input
                                                                type="hidden"
                                                                name="email"
                                                                value={
                                                                    invitation.email
                                                                }
                                                            />
                                                            <AdminSubmitButton
                                                                pendingLabel="Sending…"
                                                                size="sm"
                                                                variant="outline"
                                                                disabled={
                                                                    !emailConfigured
                                                                }
                                                            >
                                                                Resend
                                                            </AdminSubmitButton>
                                                        </form>
                                                        <form
                                                            action={
                                                                revokePremiumInvitationAction
                                                            }
                                                        >
                                                            <input
                                                                type="hidden"
                                                                name="invitationId"
                                                                value={
                                                                    invitation.id
                                                                }
                                                            />
                                                            <AdminSubmitButton
                                                                pendingLabel="Revoking…"
                                                                confirmMessage={`Revoke the invitation for ${invitation.email}?`}
                                                                size="sm"
                                                                variant="ghost"
                                                            >
                                                                Revoke
                                                            </AdminSubmitButton>
                                                        </form>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Gift className="h-4 w-4" />
                        Complimentary access
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {grants.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No complimentary grants are active.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>User</TableHead>
                                        <TableHead>Plan</TableHead>
                                        <TableHead>Granted</TableHead>
                                        <TableHead className="text-right">
                                            Action
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {grants.map((grant) => {
                                        const label =
                                            grant.user.name ??
                                            grant.user.email ??
                                            'Unknown user';
                                        return (
                                            <TableRow key={grant.id}>
                                                <TableCell>
                                                    <div className="font-medium">
                                                        {label}
                                                    </div>
                                                    {grant.user.email ? (
                                                        <div className="text-xs text-muted-foreground">
                                                            {grant.user.email}
                                                        </div>
                                                    ) : null}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge>{grant.plan}</Badge>
                                                </TableCell>
                                                <TableCell>
                                                    {grant.createdAt.toLocaleDateString()}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <form
                                                        action={
                                                            revokePlanGrantAction
                                                        }
                                                    >
                                                        <input
                                                            type="hidden"
                                                            name="grantId"
                                                            value={grant.id}
                                                        />
                                                        <AdminSubmitButton
                                                            pendingLabel="Revoking…"
                                                            confirmMessage={`Revoke complimentary Pro for ${label}?`}
                                                            size="sm"
                                                            variant="outline"
                                                        >
                                                            Revoke access
                                                        </AdminSubmitButton>
                                                    </form>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
