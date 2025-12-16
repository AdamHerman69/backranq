import { SignInButton } from '@/components/auth/SignInButton';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

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
        <main style={{ padding: 24 }}>
            <h1>Sign in</h1>
            <p>Use Google or GitHub to sign in to BackRank.</p>
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                <SignInButton provider="google" callbackUrl={callbackUrl}>
                    Sign in with Google
                </SignInButton>
                <SignInButton provider="github" callbackUrl={callbackUrl}>
                    Sign in with GitHub
                </SignInButton>
            </div>
        </main>
    );
}

