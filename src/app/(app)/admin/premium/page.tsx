import { Gift, Mail, Send, ShieldCheck, Users } from 'lucide-react';

import { PageHeader } from '@/components/app/PageHeader';
import { Badge } from '@/components/ui/badge';
import { EmptyState, InlineStatus } from '@/components/ui/async-state';
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
        <div className="space-y-6 sm:space-y-8">
            <PageHeader
                eyebrow="Operations"
                title="Premium"
                subtitle="Invite people to complimentary Backranq Pro and manage active access."
            />

            <Card variant="panel" className="overflow-hidden">
                <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <Mail className="h-4 w-4" aria-hidden="true" />
                        </span>
                            Invite to Pro
                    </CardTitle>
                    <CardDescription>
                        Send one 14-day, single-use invitation. Access is granted
                        only after sign-in with the invited address.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                    <InlineStatus tone={emailConfigured ? 'success' : 'danger'}>
                        {emailConfigured
                            ? 'Invitation delivery is ready. Sending creates an audited, single-use link.'
                            : 'Invitation email is not configured. Sending is disabled until delivery is available.'}
                    </InlineStatus>
                    <PremiumInviteForm disabled={!emailConfigured} />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        Resending a delivered invitation requires confirmation and
                        invalidates the previously delivered link.
                    </p>
                </CardContent>
            </Card>

            <div className="grid gap-3 sm:grid-cols-3">
                <OperationalMetric
                    icon={<Send aria-hidden="true" />}
                    label="Pending invitations"
                    value={invitations.length}
                    detail="Active, unaccepted links"
                />
                <OperationalMetric
                    icon={<Users aria-hidden="true" />}
                    label="Complimentary access"
                    value={grants.length}
                    detail="Currently active grants"
                />
                <Card variant="subtle">
                    <CardContent className="flex h-full items-start gap-3 p-4">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div>
                            <p className="text-sm font-semibold">Administrator access</p>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                Active database-backed administrators receive Pro automatically.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Card variant="panel" className="overflow-hidden">
                <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                    <CardTitle className="text-base">
                        Pending invitations
                    </CardTitle>
                    <CardDescription>
                        A confirmed resend rotates the token. Failed or ambiguous
                        delivery retries reuse the same valid link.
                    </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                    {invitations.length === 0 ? (
                        <EmptyState
                            title="No pending invitations"
                            description="New invitations will appear here until they are accepted, revoked, or expire."
                            icon={<Mail aria-hidden="true" />}
                            className="rounded-none border-0"
                        />
                    ) : (
                        <div className="overflow-x-auto p-3 sm:p-4">
                            <Table className="min-w-[680px]">
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
                                                    <div className="flex justify-end gap-2 whitespace-nowrap">
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
                                                            className="text-destructive hover:bg-destructive/5 hover:text-destructive"
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

            <Card variant="panel" className="overflow-hidden">
                <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Gift className="h-4 w-4" />
                        Complimentary access
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {grants.length === 0 ? (
                        <EmptyState
                            title="No active complimentary access"
                            description="Accepted invitations and manual complimentary grants will appear here."
                            icon={<Gift aria-hidden="true" />}
                            className="rounded-none border-0"
                        />
                    ) : (
                        <div className="overflow-x-auto p-3 sm:p-4">
                            <Table className="min-w-[640px]">
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
                                                        variant="destructive"
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

function OperationalMetric({
    icon,
    label,
    value,
    detail,
}: {
    icon: React.ReactNode;
    label: string;
    value: number;
    detail: string;
}) {
    return (
        <Card variant="panel">
            <CardContent className="flex items-start gap-3 p-4">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-inset text-primary [&_svg]:h-4 [&_svg]:w-4">
                    {icon}
                </span>
                <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                        {label}
                    </p>
                    <p className="mt-0.5 text-2xl font-semibold tracking-[-0.04em]">{value}</p>
                    <p className="text-xs text-muted-foreground">{detail}</p>
                </div>
            </CardContent>
        </Card>
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
