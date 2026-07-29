'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { PageHeader } from '@/components/app/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function ProgressError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="space-y-6">
            <PageHeader
                title="Progress"
                subtitle="Your games and Practice history are unchanged."
            />
            <Card role="alert">
                <CardContent className="py-8">
                    <h2 className="font-semibold">
                        Progress is temporarily unavailable
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                        Backranq could not assemble a trustworthy snapshot. Try
                        again, or continue with your existing Positions.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                        <Button
                            type="button"
                            className="min-h-11"
                            onClick={reset}
                        >
                            Try again
                        </Button>
                        <Button
                            asChild
                            variant="outline"
                            className="min-h-11"
                        >
                            <Link href="/practice?entry=progress">
                                Open Practice
                            </Link>
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
