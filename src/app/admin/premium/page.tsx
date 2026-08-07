import { Gift, Mail, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/app/PageHeader';
import { Badge } from '@/components/ui/badge';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
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
    PremiumCommandButton,
    PremiumInviteForm,
} from './PremiumCommandControls';

export const dynamic = 'force-dynamic';

export default async function PremiumAdminPage() {
    await requireAdminSession('PREMIUM_MANAGE');

    const now = new Date();
    const [invitations, grants] = await Promise.all([
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
    ]);
    const emailConfigured = Boolean(
        process.env.SMTP2GO_API_KEY && process.env.BACKRANQ_EMAIL_FROM
    );

    return (
        <div className="space-y-6">
            <PageHeader
                title="Premium"
                subtitle="Invite people to complimentary Backranq Pro and manage active access."
            />

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
                        <PremiumInviteForm disabled={!emailConfigured} />
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
                        A confirmed resend rotates the token. Failed or ambiguous
                        delivery retries reuse the same valid link.
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
                                        const status = deliveryLabel(
                                            invitation.deliveryStatus
                                        );
                                        return (
                                            <TableRow key={invitation.id}>
                                                <TableCell className="font-medium">
                                                    {invitation.email}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant={
                                                            invitation.deliveryStatus ===
                                                                'FAILED'
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
                                                        <PremiumCommandButton
                                                            command={{
                                                                type: 'RESEND_INVITATION',
                                                                invitationId:
                                                                    invitation.id,
                                                            }}
                                                            confirmMessage={
                                                                invitation.deliveryStatus ===
                                                                'SENT'
                                                                    ? `Send a new invitation link to ${invitation.email}? The previously delivered link will stop working.`
                                                                    : undefined
                                                            }
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={!emailConfigured}
                                                        >
                                                            Resend
                                                        </PremiumCommandButton>
                                                        <PremiumCommandButton
                                                            command={{
                                                                type: 'REVOKE_INVITATION',
                                                                invitationId:
                                                                    invitation.id,
                                                            }}
                                                            confirmMessage={`Revoke the invitation for ${invitation.email}?`}
                                                            size="sm"
                                                            variant="ghost"
                                                        >
                                                            Revoke
                                                        </PremiumCommandButton>
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
                                                    <PremiumCommandButton
                                                        command={{
                                                            type: 'REVOKE_GRANT',
                                                            grantId: grant.id,
                                                        }}
                                                        confirmMessage={`Revoke complimentary Pro for ${label}?`}
                                                        size="sm"
                                                        variant="outline"
                                                    >
                                                        Revoke access
                                                    </PremiumCommandButton>
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

function deliveryLabel(status: string) {
    switch (status) {
        case 'SENDING':
            return 'Sending';
        case 'SENT':
            return 'Sent';
        case 'AMBIGUOUS':
            return 'Delivery unknown';
        case 'FAILED':
            return 'Email issue';
        default:
            return 'Pending';
    }
}
