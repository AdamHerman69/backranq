import { SignInButton } from '@/components/auth/SignInButton';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
                        Use Google or GitHub to sign in to BackRank.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    <SignInButton
                        provider="google"
                        callbackUrl={callbackUrl}
                        className="w-full"
                    >
                        Sign in with Google
                    </SignInButton>
                    <SignInButton
                        provider="github"
                        callbackUrl={callbackUrl}
                        className="w-full"
                        variant="outline"
                    >
                        Sign in with GitHub
                    </SignInButton>
                </CardContent>
            </Card>
        </main>
    );
}

