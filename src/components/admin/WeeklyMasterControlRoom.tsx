'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
    Activity,
    AlertTriangle,
    Bot,
    CheckCircle2,
    ExternalLink,
    PauseCircle,
    PlayCircle,
    RefreshCw,
    ShieldCheck,
    Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { MasterPuzzlePreview } from '@/components/admin/MasterPuzzlePreview';
import { PageHeader } from '@/components/app/PageHeader';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { EmptyState, InlineStatus } from '@/components/ui/async-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/ui/loading-button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    ADMIN_IDEMPOTENCY_HEADER,
    ADMIN_REQUEST_HEADER,
} from '@/lib/admin/contracts';
import type { AdminCapability, AdminRole } from '@/lib/auth/admin';
import type {
    MasterAdminCommand,
    WeeklyMasterAdminSnapshot,
} from '@/lib/master/adminContracts';

function formatDate(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value: number | null): string {
    if (value === null) return '—';
    if (value < 1_000) return `${Math.round(value)} ms`;
    return `${(value / 1_000).toFixed(1)} s`;
}

function expiry(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString();
}

function statusVariant(value: string) {
    if (value === 'FAILED' || value === 'BLOCKED' || value === 'MISSING') {
        return 'destructive' as const;
    }
    if (value === 'SUCCEEDED' || value === 'FRESH' || value === 'AVAILABLE') {
        return 'secondary' as const;
    }
    return 'outline' as const;
}

export function WeeklyMasterControlRoom({
    snapshot,
    role,
    capabilities,
}: {
    snapshot: WeeklyMasterAdminSnapshot;
    role: AdminRole;
    capabilities: AdminCapability[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [reason, setReason] = useState('');
    const [selectedCandidateId, setSelectedCandidateId] = useState(
        snapshot.candidates[0]?.id ?? null
    );
    const [confirmation, setConfirmation] = useState<{
        label: string;
        command: MasterAdminCommand;
        destructive: boolean;
        description: string;
    } | null>(null);
    const selectedCandidate = useMemo(
        () =>
            snapshot.candidates.find(
                (candidate) => candidate.id === selectedCandidateId
            ) ?? null,
        [selectedCandidateId, snapshot.candidates]
    );
    const can = (capability: AdminCapability) =>
        capabilities.includes(capability);
    const reasonReady = reason.trim().length >= 4;
    const slotKey =
        snapshot.automation.currentSlotKey ?? 'landing-weekly-master';
    const latestProblemRun = snapshot.latestRuns.find(
        (run) => run.status === 'FAILED' || run.status === 'BLOCKED'
    );
    const automationPaused = snapshot.automation.mode === 'PAUSED';
    const needsAttention = automationPaused || Boolean(latestProblemRun);

    const sendCommand = (command: MasterAdminCommand) => {
        startTransition(async () => {
            try {
                const response = await fetch(
                    '/api/admin/weekly-master/commands',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            [ADMIN_REQUEST_HEADER]: '1',
                            [ADMIN_IDEMPOTENCY_HEADER]: crypto.randomUUID(),
                        },
                        body: JSON.stringify(command),
                    }
                );
                const payload = (await response.json().catch(() => null)) as
                    | { error?: string; replayed?: boolean }
                    | null;
                if (!response.ok) {
                    throw new Error(payload?.error ?? 'Admin command failed');
                }
                toast.success(payload?.replayed ? 'Command already applied' : 'Command accepted');
                setReason('');
                router.refresh();
            } catch (error) {
                toast.error(
                    error instanceof Error ? error.message : 'Admin command failed'
                );
            }
        });
    };

    const commandButton = (
        label: string,
        command: MasterAdminCommand,
        opts: {
            destructive?: boolean;
            disabled?: boolean;
            confirm?: string;
        } = {}
    ) => (
        <LoadingButton
            size="sm"
            variant={opts.destructive ? 'destructive' : 'outline'}
            loading={pending}
            loadingLabel="Working…"
            disabled={!reasonReady || opts.disabled}
            onClick={() => {
                if (opts.destructive || opts.confirm) {
                    setConfirmation({
                        label,
                        command,
                        destructive: Boolean(opts.destructive),
                        description:
                            opts.confirm ??
                            `${label}? This temporary correction will be audited with reason “${reason.trim()}”.`,
                    });
                    return;
                }
                sendCommand(command);
            }}
        >
            {label}
        </LoadingButton>
    );

    return (
        <div className="space-y-6 sm:space-y-8">
            <PageHeader
                eyebrow="Operations"
                title="Weekly Master control room"
                subtitle={`Autonomous editorial pipeline · ${role.toLowerCase()} access · snapshot ${formatDate(snapshot.generatedAt)}`}
                actions={
                    <Button variant="outline" size="sm" onClick={() => router.refresh()} disabled={pending}>
                        <RefreshCw /> Refresh
                    </Button>
                }
            />

            <Card
                variant="panel"
                className={
                    needsAttention
                        ? 'overflow-hidden border-warning/35'
                        : 'overflow-hidden border-success/30'
                }
            >
                <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-start gap-3">
                            <span
                                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                                    needsAttention
                                        ? 'bg-warning/10 text-warning'
                                        : 'bg-success/10 text-success'
                                }`}
                            >
                                {automationPaused ? (
                                    <PauseCircle className="h-4 w-4" aria-hidden="true" />
                                ) : (
                                    <Bot className="h-4 w-4" aria-hidden="true" />
                                )}
                            </span>
                            <div>
                                <CardTitle className="text-base">
                                    {automationPaused
                                        ? 'Automation is paused'
                                        : 'Autonomous pipeline is active'}
                                </CardTitle>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {automationPaused
                                        ? `Pause expires ${formatDate(snapshot.automation.pausedUntil)}.`
                                        : 'Safe material continues through ingest, analysis, and publication policy.'}
                                </p>
                            </div>
                        </div>
                        <Badge
                            variant="outline"
                            className={
                                needsAttention
                                    ? 'w-fit border-warning/20 bg-warning/10 text-warning'
                                    : 'w-fit border-success/20 bg-success/10 text-success'
                            }
                        >
                            {needsAttention ? 'Review needed' : 'Operational'}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-5">
                    <InlineStatus tone={needsAttention ? 'warning' : 'success'}>
                        {automationPaused
                            ? 'Next safe action: verify that the pause is intentional before forcing any stage. Let the temporary pause expire when no intervention is needed.'
                            : latestProblemRun
                              ? `Next safe action: inspect ${latestProblemRun.stage} run ${latestProblemRun.runKey} below before retrying that stage.`
                              : 'No action is required. Manual controls are for targeted corrections and wake-ups, not routine operation.'}
                    </InlineStatus>

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                        <label htmlFor="admin-reason" className="block min-w-0">
                            <span className="text-sm font-medium">Reason for the next change</span>
                            <span className="ml-2 text-xs text-muted-foreground">Required · minimum 4 characters</span>
                            <Input
                                id="admin-reason"
                                className="mt-2"
                                maxLength={500}
                                value={reason}
                                onChange={(event) => setReason(event.target.value)}
                                placeholder="Describe the operational evidence and intended outcome"
                            />
                        </label>
                        <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
                        {can('MASTER_RUN')
                            ? commandButton('Force next ingest', {
                                  type: 'FORCE_PIPELINE',
                                  scope: 'INGEST',
                                  reason,
                              })
                            : null}
                        {can('MASTER_RUN')
                            ? commandButton('Force next analysis', {
                                  type: 'FORCE_PIPELINE',
                                  scope: 'ANALYSIS',
                                  reason,
                              })
                            : null}
                        {can('OPS_MUTATE')
                            ? commandButton('Pause for 24 hours', {
                                  type: 'PAUSE_AUTOMATION',
                                  expiresAt: expiry(1),
                                  reason,
                              }, {
                                  confirm: `Pause autonomous processing for 24 hours? The reason “${reason.trim()}” will be audited.`,
                              })
                            : null}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {[
                    ['Users', snapshot.stats.users],
                    ['Linked accounts', snapshot.stats.linkedAccounts],
                    ['Source games', snapshot.stats.sourceGames],
                    ['Eligible', snapshot.stats.eligibleCandidates],
                    ['Published', snapshot.stats.publishedPuzzles],
                    ['Failed runs', snapshot.stats.failedRuns],
                ].map(([label, value]) => (
                    <Card key={label} variant="panel">
                        <CardContent className="p-3.5 sm:p-4">
                            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                                {label}
                            </p>
                            <p
                                className={`mt-1 text-2xl font-semibold tracking-[-0.04em] ${
                                    label === 'Failed runs' && Number(value) > 0
                                        ? 'text-destructive'
                                        : ''
                                }`}
                            >
                                {value}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <Tabs defaultValue="pipeline" className="space-y-4">
                <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
                <TabsList className="h-auto min-w-max flex-nowrap justify-start">
                    <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
                    <TabsTrigger value="roster">Roster</TabsTrigger>
                    <TabsTrigger value="games">Source games</TabsTrigger>
                    <TabsTrigger value="candidates">Candidates</TabsTrigger>
                    <TabsTrigger value="publications">Puzzles</TabsTrigger>
                    {can('USER_VIEW') ? <TabsTrigger value="users">Users</TabsTrigger> : null}
                </TabsList>
                </div>

                <TabsContent value="pipeline">
                    <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Dual-onboarding funnel · last {snapshot.onboardingFunnel.windowDays} days</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                {[
                                    ['Landing', snapshot.onboardingFunnel.landingViewed],
                                    ['Username submitted', snapshot.onboardingFunnel.identitySubmitted],
                                    ['Lookup succeeded', snapshot.onboardingFunnel.lookupSucceeded],
                                    ['Analysis started', snapshot.onboardingFunnel.analysisStarted],
                                    ['Analysis failed', snapshot.onboardingFunnel.analysisFailed],
                                    ['Personal ready', snapshot.onboardingFunnel.personalReady],
                                    ['Master terminal', snapshot.onboardingFunnel.masterTerminal],
                                    ['Handoff clicked', snapshot.onboardingFunnel.handoffClicked],
                                    ['Personal started', snapshot.onboardingFunnel.personalStarted],
                                    ['Personal terminal', snapshot.onboardingFunnel.personalTerminal],
                                ].map(([label, value]) => (
                                    <div key={label} className="rounded-lg border bg-muted/20 p-3">
                                        <p className="text-xs text-muted-foreground">{label}</p>
                                        <p className="mt-1 text-xl font-semibold">{value}</p>
                                    </div>
                                ))}
                                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                                    <p className="text-xs text-muted-foreground">Personal activation</p>
                                    <p className="mt-1 text-xl font-semibold">
                                        {snapshot.onboardingFunnel.activationRate === null
                                            ? '—'
                                            : `${Math.round(snapshot.onboardingFunnel.activationRate * 100)}%`}
                                    </p>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                                <Badge variant="outline">Readiness median {formatDuration(snapshot.onboardingFunnel.readinessMedianMs)}</Badge>
                                <Badge variant="outline">Readiness P90 {formatDuration(snapshot.onboardingFunnel.readinessP90Ms)}</Badge>
                            </div>
                        </CardContent>
                    </Card>
                    <Card variant="panel" className="overflow-hidden">
                        <CardHeader className="border-b border-border/70 bg-surface-subtle/50"><CardTitle className="text-base">Active temporary overrides</CardTitle></CardHeader>
                        <CardContent className={snapshot.activeOverrides.length === 0 ? 'p-0' : 'p-3 sm:p-4'}>
                            {snapshot.activeOverrides.length === 0 ? (
                                <EmptyState
                                    title="Autonomous policy is fully in control"
                                    description="No temporary overrides are active."
                                    icon={<CheckCircle2 aria-hidden="true" />}
                                    className="rounded-none border-0"
                                />
                            ) : (
                                <Table className="min-w-[720px]">
                                    <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Target</TableHead><TableHead>Expires</TableHead><TableHead>Reason</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
                                    <TableBody>{snapshot.activeOverrides.map((override) => <TableRow key={override.id}><TableCell><Badge variant="outline">{override.kind}</Badge></TableCell><TableCell>{override.targetLabel}</TableCell><TableCell>{formatDate(override.expiresAt)}</TableCell><TableCell className="max-w-sm text-muted-foreground">{override.reason}</TableCell><TableCell>{can('OPS_MUTATE') ? commandButton('Revoke', { type: 'REVOKE_OVERRIDE', overrideId: override.id, reason }, { destructive: true }) : null}</TableCell></TableRow>)}</TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                    <Card variant="panel" className="overflow-hidden">
                        <CardHeader className="border-b border-border/70 bg-surface-subtle/50"><CardTitle className="text-base">Recent pipeline runs</CardTitle></CardHeader>
                        <CardContent className={snapshot.latestRuns.length === 0 ? 'p-0' : 'p-3 sm:p-4'}>
                            {snapshot.latestRuns.length === 0 ? (
                                <EmptyState
                                    title="No pipeline runs yet"
                                    description="Scheduled and manually triggered runs will appear here."
                                    icon={<AlertTriangle aria-hidden="true" />}
                                    className="rounded-none border-0"
                                />
                            ) : (
                            <Table className="min-w-[760px]">
                                <TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Stage</TableHead><TableHead>Status</TableHead><TableHead>Trigger</TableHead><TableHead>Started</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
                                <TableBody>
                                    {snapshot.latestRuns.map((run) => (
                                        <TableRow key={run.id}>
                                            <TableCell className="font-mono text-xs">{run.runKey}</TableCell>
                                            <TableCell>{run.stage}</TableCell>
                                            <TableCell><Badge variant={statusVariant(run.status)}>{run.status}</Badge></TableCell>
                                            <TableCell>{run.trigger}</TableCell>
                                            <TableCell>{formatDate(run.startedAt ?? run.scheduledFor)}</TableCell>
                                            <TableCell className="max-w-xs truncate text-destructive">{run.lastError ?? '—'}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            )}
                        </CardContent>
                    </Card>
                    </div>
                </TabsContent>

                <TabsContent value="roster">
                    <div className="grid gap-4 xl:grid-cols-2">
                        {snapshot.roster.map((person) => (
                            <Card key={person.id}>
                                <CardHeader>
                                    <div className="flex items-start justify-between gap-3">
                                        <div><CardTitle>{person.displayName}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{person.attributionLabel}</p></div>
                                        {person.excludedUntil ? <Badge variant="destructive">Excluded until {formatDate(person.excludedUntil)}</Badge> : <Badge variant="secondary">Active</Badge>}
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {person.accounts.map((account) => (
                                        <div key={account.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                                            <div><p className="font-medium">{account.provider} · {account.username}</p><p className="text-xs text-muted-foreground">Verified {formatDate(account.identityVerifiedAt)} · last success {formatDate(account.lastSuccessAt)}</p>{account.lastError ? <p className="mt-1 text-xs text-destructive">{account.lastError}</p> : null}</div>
                                            <div className="flex gap-2">
                                                <Button asChild size="sm" variant="ghost"><a href={account.profileUrl} target="_blank" rel="noreferrer"><ExternalLink /> Profile</a></Button>
                                                {can('MASTER_EDIT') ? commandButton('Exclude 7d', { type: 'EXCLUDE_ACCOUNT', accountId: account.id, expiresAt: expiry(7), reason }, { destructive: true }) : null}
                                            </div>
                                        </div>
                                    ))}
                                    {can('MASTER_EDIT') ? commandButton('Exclude person for 7 days', { type: 'EXCLUDE_PERSON', personId: person.id, expiresAt: expiry(7), reason }, { destructive: true }) : null}
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="games">
                    <Card><CardHeader><CardTitle>Latest immutable source snapshots</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Provider</TableHead><TableHead>Game</TableHead><TableHead>Availability</TableHead><TableHead>Played</TableHead><TableHead>Seen</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{snapshot.sourceGames.map((game) => <TableRow key={game.id}><TableCell>{game.personLabel}</TableCell><TableCell>{game.provider}</TableCell><TableCell>{game.canonicalUrl ? <a href={game.canonicalUrl} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{game.matchup ?? game.externalId}</a> : game.matchup ?? game.externalId}</TableCell><TableCell><Badge variant={statusVariant(game.availability)}>{game.availability}</Badge></TableCell><TableCell>{formatDate(game.playedAt)}</TableCell><TableCell>{formatDate(game.lastSeenAt)}</TableCell><TableCell>{can('MASTER_RUN') ? commandButton('Analyze this game', { type: 'ANALYZE_SOURCE_GAME', sourceGameId: game.id, reason }, { disabled: game.availability !== 'AVAILABLE' }) : null}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
                </TabsContent>

                <TabsContent value="candidates">
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,480px)]">
                        <Card><CardHeader><CardTitle>Ranked candidate positions</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Score</TableHead><TableHead>Evidence</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{snapshot.candidates.map((candidate) => <TableRow key={candidate.id} data-state={candidate.id === selectedCandidateId ? 'selected' : undefined}><TableCell><button type="button" className="text-left font-medium hover:underline" onClick={() => setSelectedCandidateId(candidate.id)}>{candidate.personLabel}</button></TableCell><TableCell>{candidate.score.toFixed(1)}</TableCell><TableCell className="max-w-xs text-xs text-muted-foreground">{candidate.evidenceSummary}</TableCell><TableCell><Badge variant={candidate.hardGatePassed ? statusVariant(candidate.status) : 'destructive'}>{candidate.status}</Badge></TableCell><TableCell><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setSelectedCandidateId(candidate.id)}>Preview</Button>{can('MASTER_EDIT') && candidate.hardGatePassed ? commandButton('Approve', { type: 'APPROVE_CANDIDATE', candidateId: candidate.id, reason }, { disabled: candidate.status === 'PUBLISHED' }) : null}{can('MASTER_PUBLISH') && candidate.hardGatePassed ? commandButton('Select & pin 7d', { type: 'SELECT_CANDIDATE', candidateId: candidate.id, slotKey, expiresAt: expiry(7), reason }) : null}{can('MASTER_EDIT') ? commandButton('Exclude', { type: 'EXCLUDE_CANDIDATE', candidateId: candidate.id, reason }, { destructive: true, disabled: candidate.status === 'PUBLISHED' }) : null}</div></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
                        <MasterPuzzlePreview candidate={selectedCandidate} />
                    </div>
                </TabsContent>

                <TabsContent value="publications">
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{snapshot.publications.map((publication) => <Card key={publication.id}><CardHeader><div className="flex flex-wrap gap-2"><Badge variant={statusVariant(publication.health)}>{publication.health}</Badge>{publication.isFallback ? <Badge variant="outline">Fallback</Badge> : null}</div><CardTitle className="pt-2 text-base">{publication.headline}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p className="text-muted-foreground">{publication.attribution}</p><p>Published {formatDate(publication.publishedAt)}</p><div className="flex flex-wrap gap-2">{publication.sourceUrl ? <Button asChild size="sm" variant="ghost"><a href={publication.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink /> Source</a></Button> : null}{can('MASTER_PUBLISH') ? commandButton('Pin 7d', { type: 'PIN_PUBLICATION', publicationId: publication.id, slotKey, expiresAt: expiry(7), reason }) : null}{can('MASTER_PUBLISH') ? commandButton('Withdraw 7d', { type: 'WITHDRAW_PUBLICATION', publicationId: publication.id, expiresAt: expiry(7), reason }, { destructive: true }) : null}</div></CardContent></Card>)}</div>
                </TabsContent>

                {can('USER_VIEW') ? <TabsContent value="users"><Card><CardHeader><CardTitle>Recent users · minimized operational view</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>User</TableHead><TableHead>Created</TableHead><TableHead>Providers</TableHead><TableHead>Games</TableHead><TableHead>Last analysis</TableHead></TableRow></TableHeader><TableBody>{snapshot.recentUsers.map((user) => <TableRow key={user.id}><TableCell><p className="font-medium">{user.displayName}</p><p className="font-mono text-xs text-muted-foreground">{user.id}</p></TableCell><TableCell>{formatDate(user.createdAt)}</TableCell><TableCell>{user.linkedProviders.join(', ') || '—'}</TableCell><TableCell>{user.gameCount}</TableCell><TableCell>{formatDate(user.lastAnalysisAt)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></TabsContent> : null}
            </Tabs>

            <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><ShieldCheck /> Every mutation is capability-checked, idempotent, and audited.</span>
                <span className="inline-flex items-center gap-1"><Activity /> Public reads use only published immutable revisions.</span>
                <span className="inline-flex items-center gap-1"><Users /> User data is minimized; email and OAuth credentials are never returned.</span>
                <span className="inline-flex items-center gap-1"><PlayCircle /> Manual controls wake the autonomous pipeline; they are not a publishing gate.</span>
            </div>

            <ActionConfirmDialog
                open={confirmation !== null}
                onOpenChange={(open) => {
                    if (!open) setConfirmation(null);
                }}
                title={confirmation?.destructive ? 'Confirm destructive correction' : 'Confirm operational change'}
                description={confirmation?.description ?? ''}
                confirmLabel={confirmation?.label ?? 'Confirm'}
                variant={confirmation?.destructive ? 'destructive' : 'default'}
                busy={pending}
                onConfirm={() => {
                    if (!confirmation) return;
                    const command = confirmation.command;
                    setConfirmation(null);
                    sendCommand(command);
                }}
            />
        </div>
    );
}
