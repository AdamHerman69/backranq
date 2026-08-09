import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
    ArrowRight,
    BrainCircuit,
    CloudCog,
    EyeOff,
    RefreshCw,
} from 'lucide-react';

import { SignInButton } from '@/components/auth/SignInButton';
import { DualOnboardingHero } from '@/components/landing/DualOnboardingHero';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';
import { AUTH_PROVIDER_UI } from '@/lib/auth/config';

export const metadata: Metadata = {
    title: 'Backranq — Practice decisions from your own chess games',
    description:
        'Turn your own chess games into focused, spoiler-free practice positions.',
};

export default async function LandingPage() {
    const session = await auth();
    const isSignedIn = Boolean(session?.user?.id);

    return (
        <div className="min-h-dvh">
            <header className="sticky top-0 z-50 border-b border-foreground/10 bg-background/[0.9] backdrop-blur-xl">
                <div className="app-container flex h-14 items-center justify-between gap-4 sm:h-16">
                    <Link
                        href="/"
                        className="group inline-flex items-center gap-2.5 font-semibold tracking-[-0.03em]"
                        aria-label="Backranq home"
                    >
                        <span
                            className="relative inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-sm bg-foreground text-[11px] font-bold text-background shadow-control after:absolute after:-right-1 after:-top-1 after:h-3 after:w-3 after:rounded-full after:bg-accent transition-transform duration-200 group-hover:-rotate-2"
                            aria-hidden="true"
                        >
                            B
                        </span>
                        Backranq
                    </Link>
                    {isSignedIn ? (
                        <Button asChild size="sm">
                            <Link href="/home">Open app</Link>
                        </Button>
                    ) : (
                        <Button asChild variant="outline" size="sm">
                            <Link href="/login?callbackUrl=%2Fhome">
                                Sign in
                            </Link>
                        </Button>
                    )}
                </div>
            </header>

            <main className="space-y-16 pb-16 sm:space-y-24 sm:pb-24">
                <DualOnboardingHero isSignedIn={isSignedIn} />

                <section
                    className="app-container"
                    aria-labelledby="difference-heading"
                >
                    <div className="mb-10 max-w-2xl sm:mb-14">
                        <p className="editorial-label">Why it sticks</p>
                        <h2
                            id="difference-heading"
                            className="display-title mt-3 text-4xl sm:text-5xl"
                        >
                            Built around the decisions that cost you
                        </h2>
                        <p className="mt-3 text-muted-foreground">
                            A direct loop from the games you play to the
                            positions worth revisiting.
                        </p>
                    </div>
                    <div className="grid gap-x-8 gap-y-8 md:grid-cols-2 lg:grid-cols-4">
                        <FeatureCard
                            icon={
                                <RefreshCw
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                            title="Your games stay current"
                            description="Connect Lichess or Chess.com and keep new games synced without spending analysis credits."
                        />
                        <FeatureCard
                            icon={
                                <BrainCircuit
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                            title="More than tactics"
                            description="Revisit mistakes, missed opportunities and quiet improvements through one consistent best-move flow."
                        />
                        <FeatureCard
                            icon={
                                <EyeOff
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                            title="Spoiler-free by design"
                            description="You do not know the lesson or solution shape until after your attempt."
                        />
                        <FeatureCard
                            icon={
                                <CloudCog
                                    className="h-5 w-5"
                                    aria-hidden="true"
                                />
                            }
                            title="Analyze your way"
                            description="Use free analysis in your browser or let server analysis continue while you are away."
                        />
                    </div>
                </section>

                <section
                    className="app-container"
                    aria-labelledby="how-it-works-heading"
                >
                    <div className="overflow-hidden rounded-xl bg-foreground text-background shadow-floating">
                        <div className="p-6 sm:p-10 lg:p-12">
                            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                                        The loop
                                    </p>
                                    <h2
                                        id="how-it-works-heading"
                                        className="display-title mt-3 text-4xl sm:text-5xl"
                                    >
                                        Play. Review. Recognize it next time.
                                    </h2>
                                    <p className="mt-4 text-sm leading-6 text-background/60">
                                        Backranq keeps the workflow simple so
                                        the work stays on the board.
                                    </p>
                                </div>
                                <ol className="grid gap-6 border-t border-background/15 pt-6 sm:grid-cols-3 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0 [&_p]:text-background/55">
                                    <Step
                                        number="01"
                                        title="Connect"
                                        description="Link a public chess profile and import the games you want."
                                    />
                                    <Step
                                        number="02"
                                        title="Analyze"
                                        description="Find stable, meaningful decisions with Stockfish."
                                    />
                                    <Step
                                        number="03"
                                        title="Practice"
                                        description="Play your move first, then compare it with the engine-backed review."
                                    />
                                </ol>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="app-container text-center">
                    <div className="mx-auto max-w-2xl border-y border-foreground/10 py-12 sm:py-16">
                    <h2 className="display-title text-4xl sm:text-5xl">
                        Make your own games useful.
                    </h2>
                    <p className="mt-3 text-muted-foreground">
                        Build a practice feed from positions you actually
                        reached.
                    </p>
                    <div className="mt-7">
                        <LandingActions isSignedIn={isSignedIn} />
                    </div>
                    </div>
                </section>
            </main>

            <footer className="border-t border-border/70">
                <div className="app-container flex flex-col gap-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                        <span
                            className="inline-flex h-7 w-7 items-center justify-center rounded-sm bg-foreground text-[10px] font-bold text-background"
                            aria-hidden="true"
                        >
                            B
                        </span>
                        Backranq
                    </div>
                    <nav
                        aria-label="Legal and support"
                        className="flex flex-wrap gap-x-5 gap-y-2"
                    >
                        <Link className="transition-colors hover:text-foreground" href="/privacy">
                            Privacy
                        </Link>
                        <Link className="transition-colors hover:text-foreground" href="/terms">
                            Terms
                        </Link>
                        <Link className="transition-colors hover:text-foreground" href="/support">
                            Support
                        </Link>
                    </nav>
                </div>
            </footer>
        </div>
    );
}

function LandingActions({
    isSignedIn,
    size = 'default',
}: {
    isSignedIn: boolean;
    size?: 'default' | 'large';
}) {
    const className =
        size === 'large'
            ? 'h-12 px-8 text-base font-semibold'
            : 'h-11 px-6 font-semibold';

    if (isSignedIn) {
        return (
            <Button asChild className={className}>
                <Link href="/home">
                    Open app
                    <ArrowRight aria-hidden="true" />
                </Link>
            </Button>
        );
    }

    const enabledProviders = AUTH_PROVIDER_UI.filter(
        (provider) => provider.enabled
    );

    if (enabledProviders.length === 0) {
        return (
            <Button asChild variant="outline" className={className}>
                <Link href="/support">Sign-in temporarily unavailable</Link>
            </Button>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:flex-wrap">
            <SignInButton
                provider={enabledProviders[0]!.id}
                callbackUrl="/home"
                className={className}
            >
                Get started with {enabledProviders[0]!.label}
            </SignInButton>
            {enabledProviders.length > 1 ? (
                <Button asChild variant="outline" className={className}>
                    <Link href="/login?callbackUrl=%2Fhome">
                        Other sign-in options
                    </Link>
                </Button>
            ) : null}
        </div>
    );
}

function FeatureCard({
    icon,
    title,
    description,
}: {
    icon: ReactNode;
    title: string;
    description: string;
}) {
    return (
        <article className="group border-t border-foreground/15 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                <div className="mb-5 inline-flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-primary/[0.07] text-primary transition-[background-color,transform] duration-300 group-hover:-rotate-3 group-hover:bg-accent group-hover:text-accent-foreground">
                    {icon}
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {description}
                </p>
        </article>
    );
}

function Step({
    number,
    title,
    description,
}: {
    number: string;
    title: string;
    description: string;
}) {
    return (
        <li>
            <div className="font-mono text-xs font-semibold text-muted-foreground">
                {number}
            </div>
            <h3 className="mt-2 font-medium">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {description}
            </p>
        </li>
    );
}
