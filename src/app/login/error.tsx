'use client';

import Link from 'next/link';
import { CircleAlert, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function LoginError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <main className="flex min-h-dvh items-center justify-center px-4 py-10">
            <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-6 text-center shadow-xl sm:p-8">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                    <CircleAlert className="h-5 w-5" aria-hidden="true" />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">Sign-in options did not load</h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Your account is unchanged. Try loading the secure sign-in options again.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                    <Button type="button" onClick={reset} className="min-h-11">
                        <RotateCcw aria-hidden="true" />
                        Try again
                    </Button>
                    <Button asChild variant="outline" className="min-h-11">
                        <Link href="/support">Get help</Link>
                    </Button>
                </div>
                <Button asChild variant="ghost" className="mt-2 min-h-11 w-full">
                    <Link href="/">Back to Backranq</Link>
                </Button>
            </div>
        </main>
    );
}
