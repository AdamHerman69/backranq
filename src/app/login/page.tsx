import { SignInButton } from '@/components/auth/SignInButton';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CircleAlert, LockKeyhole, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { safeAuthCallbackUrl } from '@/lib/auth/callbackUrl';
import { AUTH_PROVIDER_UI } from '@/lib/auth/config';

export default async function LoginPage({
    searchParams,
}: {
    // Next.js 16: dynamic APIs are Promises
    searchParams?: Promise<{ callbackUrl?: string }>;
}) {
    const sp = (await searchParams) ?? {};
    const callbackUrl = safeAuthCallbackUrl(sp.callbackUrl);
    const session = await auth();
    const enabledProviders = AUTH_PROVIDER_UI.filter((provider) => provider.enabled);

    // If already signed in, don't show login page.
    if (session?.user) redirect(callbackUrl);

    return (
        <main className="relative flex min-h-dvh items-center overflow-hidden px-4 py-10 sm:px-6">
            <div
                className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,_hsl(var(--muted))_0,_transparent_42%),radial-gradient(circle_at_bottom_right,_hsl(var(--muted))_0,_transparent_38%)] opacity-80"
                aria-hidden="true"
            />
            <div className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-[1.75rem] border border-border/70 bg-background/90 shadow-2xl shadow-black/[0.08] backdrop-blur lg:grid-cols-[0.9fr_1.1fr]">
                <section className="hidden flex-col justify-between bg-foreground p-10 text-background lg:flex">
                    <Link
                        href="/"
                        className="inline-flex w-fit items-center gap-2 font-semibold"
                        aria-label="Back to Backranq"
                    >
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-background text-xs font-bold text-foreground">
                            B
                        </span>
                        Backranq
                    </Link>
                    <div className="py-16">
                        <Sparkles className="h-6 w-6" aria-hidden="true" />
                        <h2 className="mt-5 text-3xl font-semibold tracking-[-0.035em]">
                            Turn your own games into better decisions.
                        </h2>
                        <p className="mt-4 max-w-sm text-sm leading-6 text-background/70">
                            Save personal positions, continue your review queue and see which mistakes stop repeating.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-background/60">
                        <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
                        Your provider password is never shared with Backranq.
                    </div>
                </section>

                <section className="p-5 sm:p-8 lg:p-10" aria-labelledby="sign-in-title">
                    <Link
                        href="/"
                        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground lg:hidden"
                    >
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                        Back to Backranq
                    </Link>
                    <div className="mt-8 lg:mt-0">
                        <div className="mb-8 flex items-center gap-2 font-semibold lg:hidden">
                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-foreground text-xs font-bold text-background">
                                B
                            </span>
                            Backranq
                        </div>
                        <Card className="border-0 bg-transparent shadow-none">
                            <CardHeader className="px-0 pt-0">
                                <h1 id="sign-in-title" className="text-3xl font-semibold tracking-[-0.03em]">
                                    Welcome back
                                </h1>
                                <CardDescription className="max-w-sm leading-6">
                                    Choose an account to save your positions and continue where you left off.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3 px-0 pb-0">
                                {enabledProviders.length > 0 ? (
                                    enabledProviders.map((p, idx) => (
                                        <SignInButton
                                            key={p.id}
                                            provider={p.id}
                                            callbackUrl={callbackUrl}
                                            className="min-h-12 w-full justify-center text-sm font-semibold transition-transform active:scale-[0.985]"
                                            variant={idx === 0 ? 'default' : 'outline'}
                                        >
                                            Continue with {p.label}
                                        </SignInButton>
                                    ))
                                ) : (
                                    <div role="alert" className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-sm leading-6">
                                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                                        <p>
                                            Sign-in is temporarily unavailable. Please try again shortly or{' '}
                                            <Link className="font-medium underline underline-offset-4" href="/support">
                                                contact Support
                                            </Link>
                                            .
                                        </p>
                                    </div>
                                )}
                                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                    By continuing, you agree to the{' '}
                                    <Link className="font-medium text-foreground underline underline-offset-4" href="/terms">
                                        Terms
                                    </Link>{' '}
                                    and acknowledge the{' '}
                                    <Link className="font-medium text-foreground underline underline-offset-4" href="/privacy">
                                        Privacy Policy
                                    </Link>
                                    . Need help?{' '}
                                    <Link className="font-medium text-foreground underline underline-offset-4" href="/support">
                                        Visit Support
                                    </Link>
                                    .
                                </p>
                            </CardContent>
                        </Card>
                    </div>
                </section>
            </div>
        </main>
    );
}
