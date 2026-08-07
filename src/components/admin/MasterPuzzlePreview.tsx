'use client';

import dynamic from 'next/dynamic';
import { ExternalLink, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState, InlineStatus } from '@/components/ui/async-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BoardSkeleton } from '@/components/ui/loading-patterns';
import type { MasterCandidateSummary } from '@/lib/master/adminContracts';

const Chessboard = dynamic(
    () => import('react-chessboard').then((module) => module.Chessboard),
    {
        ssr: false,
        loading: () => <BoardSkeleton label="Loading candidate position" />,
    }
);

export function MasterPuzzlePreview({
    candidate,
}: {
    candidate: MasterCandidateSummary | null;
}) {
    if (!candidate) {
        return (
            <EmptyState
                title="Choose a candidate"
                description="Select a ranked position to inspect the exact board and engine evidence."
                icon={<Search aria-hidden="true" />}
                className="min-h-64 xl:sticky xl:top-24"
            />
        );
    }

    return (
        <Card variant="panel" className="overflow-hidden xl:sticky xl:top-24">
            <CardHeader className="space-y-3 border-b border-border/70 bg-surface-subtle/50">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={candidate.hardGatePassed ? 'secondary' : 'destructive'}>
                        {candidate.hardGatePassed ? 'Quality gates passed' : 'Blocked'}
                    </Badge>
                    <Badge variant="outline">Score {candidate.score.toFixed(1)}</Badge>
                    <Badge variant="outline">{candidate.status}</Badge>
                </div>
                <CardTitle className="text-base">
                    {candidate.personLabel} · move {Math.floor(candidate.decisionPly / 2) + 1}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="mx-auto max-w-md rounded-lg border border-border/80 bg-card p-2 shadow-raised">
                    <Chessboard
                        options={{
                            position: candidate.fen,
                            boardOrientation:
                                candidate.fen.split(' ')[1] === 'b' ? 'black' : 'white',
                            allowDragging: false,
                            allowDrawingArrows: false,
                        }}
                    />
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Played</dt>
                        <dd className="font-mono font-medium">{candidate.originalMoveUci}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Verified best move</dt>
                        <dd className="font-mono font-medium">
                            {candidate.bestMoveUci ?? 'Pending'}
                        </dd>
                    </div>
                </dl>
                <p className="text-sm text-muted-foreground">
                    {candidate.evidenceSummary}
                </p>
                {candidate.rejectionReasons.length > 0 ? (
                    <InlineStatus tone="danger">
                        <div>
                        <p className="font-medium">Rejection evidence</p>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                            {candidate.rejectionReasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                            ))}
                        </ul>
                        </div>
                    </InlineStatus>
                ) : null}
                {candidate.sourceUrl ? (
                    <Button asChild variant="outline" size="sm">
                        <a
                            href={candidate.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <ExternalLink aria-hidden="true" />
                            Open public source game
                        </a>
                    </Button>
                ) : null}
            </CardContent>
        </Card>
    );
}
