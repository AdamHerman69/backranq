'use client';

import Link from 'next/link';
import { CircleAlert, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function InvitationError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <div className="flex min-h-[calc(100dvh-7rem)] items-center py-8">
            <Card className="mx-auto w-full max-w-lg border-border/70 shadow-xl">
                <CardContent className="p-6 text-center sm:p-8">
                    <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                        <CircleAlert className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">We could not check this invitation</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        The link has not been changed or accepted. Try again, or contact Support if the problem continues.
                    </p>
                    <div className="mt-6 grid gap-2 sm:grid-cols-2">
                        <Button type="button" onClick={reset} className="min-h-11">
                            <RotateCcw aria-hidden="true" />
                            Try again
                        </Button>
                        <Button asChild variant="outline" className="min-h-11">
                            <Link href="/support">Contact support</Link>
                        </Button>
                    </div>
                    <Button asChild variant="ghost" className="mt-2 min-h-11 w-full">
                        <Link href="/">Back to Backranq</Link>
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
