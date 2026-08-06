'use client';

import dynamic from 'next/dynamic';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MasterCandidateSummary } from '@/lib/master/adminContracts';

const Chessboard = dynamic(
    () => import('react-chessboard').then((module) => module.Chessboard),
    {
        ssr: false,
        loading: () => (
            <div className="aspect-square animate-pulse rounded-lg bg-muted" />
        ),
    }
);

export function MasterPuzzlePreview({
    candidate,
}: {
    candidate: MasterCandidateSummary | null;
}) {
    if (!candidate) {
        return (
            <Card className="border-dashed">
                <CardContent className="flex min-h-64 items-center justify-center text-center text-sm text-muted-foreground">
                    Choose a candidate to inspect the exact position and engine
                    evidence.
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader className="space-y-3">
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
                <div className="mx-auto max-w-md rounded-xl border bg-card p-2">
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
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                        <p className="font-medium">Rejection evidence</p>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                            {candidate.rejectionReasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                            ))}
                        </ul>
                    </div>
                ) : null}
                {candidate.sourceUrl ? (
                    <a
                        href={candidate.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                        Open public source game
                    </a>
                ) : null}
            </CardContent>
        </Card>
    );
}
