'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { PageHeader } from '@/components/app/PageHeader';
import { ErrorState } from '@/components/ui/async-state';
import { Button } from '@/components/ui/button';

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
            <ErrorState
                title="Progress is temporarily unavailable"
                description="Backranq could not assemble a trustworthy snapshot. Your games and Practice history are unchanged."
                action={
                    <div className="flex flex-col gap-2 sm:flex-row">
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
                }
            />
        </div>
    );
}
