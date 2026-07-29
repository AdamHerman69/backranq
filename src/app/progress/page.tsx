import { redirect } from 'next/navigation';

import { ProgressDashboard } from '@/components/progress/ProgressDashboard';
import {
    parseProgressSearchParams,
    type ProgressSearchParams,
} from '@/components/progress/searchParams';
import { auth } from '@/lib/auth';
import { safeAuthCallbackUrl } from '@/lib/auth/callbackUrl';
import { getProgressSnapshot } from '@/lib/progress/readService';

export default async function ProgressPage({
    searchParams,
}: {
    searchParams?: Promise<ProgressSearchParams>;
}) {
    const parsed = parseProgressSearchParams((await searchParams) ?? {});
    const callbackUrl = safeAuthCallbackUrl(
        parsed.canonicalQuery
            ? `/progress?${parsed.canonicalQuery}`
            : '/progress',
        '/progress'
    );
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        redirect(
            `/login?${new URLSearchParams({
                callbackUrl,
            }).toString()}`
        );
    }

    const snapshot = await getProgressSnapshot({
        userId,
        scope: parsed.scope,
        asOf: new Date(),
        filters: parsed.filters,
    });

    return <ProgressDashboard snapshot={snapshot} />;
}
