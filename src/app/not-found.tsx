import Link from 'next/link';
import { ArrowLeft, Castle } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function NotFound() {
    return (
        <div className="relative isolate flex min-h-[70dvh] items-center justify-center overflow-hidden py-12">
            <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_center,_hsl(var(--muted))_0,_transparent_55%)]" aria-hidden="true" />
            <div className="mx-auto max-w-2xl px-4 text-center">
                <div className="relative mx-auto grid h-28 w-28 grid-cols-4 overflow-hidden rounded-sm border border-border/70 shadow-raised" aria-hidden="true">
                    {Array.from({ length: 16 }).map((_, index) => (
                        <span
                            key={index}
                            className={(Math.floor(index / 4) + index) % 2 === 0 ? 'bg-foreground' : 'bg-background'}
                        />
                    ))}
                    <Castle className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-emerald-500 drop-shadow" />
                </div>
                <p className="mt-8 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">404 · Position not found</p>
                <h1 className="display-title mt-3 text-4xl sm:text-6xl">
                    This line ends here.
                </h1>
                <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-muted-foreground">
                    The page may have moved, the link may be incomplete, or this route is no longer available.
                </p>
                <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">
                    <Button asChild className="min-h-11">
                        <Link href="/">
                            <ArrowLeft aria-hidden="true" />
                            Back to Backranq
                        </Link>
                    </Button>
                    <Button asChild variant="outline" className="min-h-11">
                        <Link href="/support">Get help</Link>
                    </Button>
                </div>
            </div>
        </div>
    );
}
