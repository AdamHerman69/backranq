import Link from 'next/link';
import type { ReactNode } from 'react';

export function PublicDocumentShell({
    eyebrow,
    title,
    introduction,
    updatedAt,
    children,
}: {
    eyebrow: string;
    title: string;
    introduction: string;
    updatedAt?: string;
    children: ReactNode;
}) {
    return (
        <div className="min-h-dvh bg-background">
            <header className="border-b border-border/70 bg-background/90 backdrop-blur-xl">
                <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:h-16 sm:px-6">
                    <Link href="/" className="inline-flex items-center gap-2 font-semibold" aria-label="Backranq home">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-foreground text-xs font-bold text-background">
                            B
                        </span>
                        Backranq
                    </Link>
                    <nav className="flex items-center gap-4 text-sm text-muted-foreground" aria-label="Public pages">
                        <Link className="transition-colors hover:text-foreground" href="/support">Support</Link>
                        <Link className="transition-colors hover:text-foreground" href="/login">Sign in</Link>
                    </nav>
                </div>
            </header>

            <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
                <header className="max-w-3xl border-b border-border/70 pb-10">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                        {eyebrow}
                    </p>
                    <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
                        {title}
                    </h1>
                    <p className="mt-5 text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                        {introduction}
                    </p>
                    {updatedAt ? (
                        <p className="mt-5 text-xs text-muted-foreground">Effective {updatedAt}</p>
                    ) : null}
                </header>

                <article className="mt-10 space-y-10 text-[15px] leading-7 text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:pl-1 [&_p+ul]:mt-3 [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-2">
                    {children}
                </article>
            </main>

            <footer className="border-t border-border/70">
                <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <span>Backranq · Practice decisions from your own games.</span>
                    <nav className="flex flex-wrap gap-5" aria-label="Legal links">
                        <Link href="/privacy">Privacy</Link>
                        <Link href="/terms">Terms</Link>
                        <Link href="/support">Support</Link>
                    </nav>
                </div>
            </footer>
        </div>
    );
}

export function DocumentSection({
    id,
    title,
    children,
}: {
    id: string;
    title: string;
    children: ReactNode;
}) {
    return (
        <section id={id} className="scroll-mt-24 space-y-3">
            <h2>{title}</h2>
            {children}
        </section>
    );
}
