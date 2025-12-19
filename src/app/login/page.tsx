import { SignInButton } from '@/components/auth/SignInButton';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AUTH_PROVIDER_UI } from '@/lib/auth/config';

export default async function LoginPage({
    searchParams,
}: {
    // Next.js 16: dynamic APIs are Promises
    searchParams?: Promise<{ callbackUrl?: string }>;
}) {
    const sp = (await searchParams) ?? {};
    const callbackUrl = sp.callbackUrl ?? '/dashboard';
    const session = await auth();

    // If already signed in, don't show login page.
    if (session?.user) redirect(callbackUrl);

    return (
        <main className="container flex min-h-dvh items-center justify-center py-10">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle>Sign in</CardTitle>
                    <CardDescription>
                        Choose a sign-in method to continue.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    {AUTH_PROVIDER_UI.filter((p) => p.enabled).map((p, idx) => (
                        <SignInButton
                            key={p.id}
                            provider={p.id}
                            callbackUrl={callbackUrl}
                            className="w-full"
                            variant={idx === 0 ? 'default' : 'outline'}
                        >
                            Sign in with {p.label}
                        </SignInButton>
                    ))}
                </CardContent>
            </Card>
        </main>
    );
}

