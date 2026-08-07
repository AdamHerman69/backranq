import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
    BrainCircuit,
    CloudCog,
    EyeOff,
    RefreshCw,
} from 'lucide-react';

import { SignInButton } from '@/components/auth/SignInButton';
import { DualOnboardingHero } from '@/components/landing/DualOnboardingHero';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { auth } from '@/lib/auth';

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
            <header className="border-b bg-background/80 backdrop-blur">
                <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 font-semibold tracking-tight"
                        aria-label="Backranq home"
                    >
                        <span
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-xs font-bold text-background"
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
                        <SignInButton
                            callbackUrl="/home"
                            variant="outline"
                            size="sm"
                        >
                            Sign in
                        </SignInButton>
                    )}
                </div>
            </header>

            <main className="space-y-20 pb-16 sm:space-y-24">
                <DualOnboardingHero isSignedIn={isSignedIn} />

                <section
                    className="mx-auto max-w-6xl px-4"
                    aria-labelledby="difference-heading"
                >
                    <div className="mx-auto mb-8 max-w-2xl text-center">
                        <h2
                            id="difference-heading"
                            className="text-2xl font-semibold tracking-tight sm:text-3xl"
                        >
                            Built around the decisions that cost you
                        </h2>
                        <p className="mt-3 text-muted-foreground">
                            A direct loop from the games you play to the
                            positions worth revisiting.
                        </p>
                    </div>
                    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
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
                    className="mx-auto max-w-4xl px-4"
                    aria-labelledby="how-it-works-heading"
                >
                    <Card className="overflow-hidden">
                        <CardContent className="p-6 sm:p-10">
                            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                                        The loop
                                    </p>
                                    <h2
                                        id="how-it-works-heading"
                                        className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl"
                                    >
                                        Play. Review. Recognize it next time.
                                    </h2>
                                    <p className="mt-4 text-sm leading-6 text-muted-foreground">
                                        Backranq keeps the workflow simple so
                                        the work stays on the board.
                                    </p>
                                </div>
                                <ol className="grid gap-6 sm:grid-cols-3">
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
                        </CardContent>
                    </Card>
                </section>

                <section className="mx-auto max-w-2xl px-4 text-center">
                    <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                        Make your own games useful.
                    </h2>
                    <p className="mt-3 text-muted-foreground">
                        Build a practice feed from positions you actually
                        reached.
                    </p>
                    <div className="mt-7">
                        <LandingActions isSignedIn={isSignedIn} />
                    </div>
                </section>
            </main>
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
                <Link href="/home">Open app</Link>
            </Button>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:flex-wrap">
            <SignInButton callbackUrl="/home" className={className}>
                Get started with Google
            </SignInButton>
            <SignInButton
                provider="lichess"
                callbackUrl="/home"
                variant="outline"
                className={className}
            >
                Sign in with Lichess
            </SignInButton>
            <SignInButton
                provider="github"
                callbackUrl="/home"
                variant="outline"
                className={className}
            >
                Sign in with GitHub
            </SignInButton>
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
        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
            <CardContent className="pt-6">
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                    {icon}
                </div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {description}
                </p>
            </CardContent>
        </Card>
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
