import { redirect } from 'next/navigation';
import { getRequestSession } from '@/lib/auth/requestSession';
import { safeAuthCallbackUrl } from '@/lib/auth/callbackUrl';
import { PageHeader } from '@/components/app/PageHeader';
import { TrainingTrainer } from '@/components/training/TrainingTrainer';
import { isTrainingApiUuid } from '@/lib/training/apiValidation';
import type {
    PracticeFeedInitialData,
    PracticeFeedMode,
} from '@/lib/training/api';
import { prisma } from '@/lib/prisma';
import { loadInitialPracticeFeed } from './initialPracticeFeed';

export default async function PracticePage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const sp = (await searchParams) ?? {};
    const rawMomentId =
        typeof sp.momentId === 'string' ? sp.momentId.trim() : undefined;
    const momentId =
        rawMomentId && isTrainingApiUuid(rawMomentId)
            ? rawMomentId
            : undefined;
    const entry = sp.entry === 'progress' ? 'progress' : undefined;
    const initialViewMode = sp.view === 'analyze' ? 'analyze' : 'solve';
    const initialMode: PracticeFeedMode | undefined =
        sp.mode === 'review'
            ? 'REVIEW'
            : sp.mode === 'new'
              ? 'NEW'
              : undefined;
    const rawGameId =
        typeof sp.gameId === 'string' ? sp.gameId.trim() : undefined;
    const gameId =
        rawGameId && isTrainingApiUuid(rawGameId)
            ? rawGameId
            : undefined;
    const callbackSearchParams = new URLSearchParams();
    if (momentId) callbackSearchParams.set('momentId', momentId);
    if (entry) callbackSearchParams.set('entry', entry);
    if (initialViewMode === 'analyze') {
        callbackSearchParams.set('view', 'analyze');
    }
    if (initialMode) {
        callbackSearchParams.set('mode', initialMode.toLowerCase());
    }
    if (gameId) callbackSearchParams.set('gameId', gameId);
    const practiceCallbackUrl = safeAuthCallbackUrl(
        callbackSearchParams.size > 0
            ? `/practice?${callbackSearchParams.toString()}`
            : '/practice',
        '/practice'
    );

    const session = await getRequestSession();
    const userId = session?.user?.id;
    if (!userId) {
        const loginSearchParams = new URLSearchParams({
            callbackUrl: practiceCallbackUrl,
        });
        redirect(`/login?${loginSearchParams.toString()}`);
    }

    let initialPractice: PracticeFeedInitialData;
    try {
        initialPractice = await loadInitialPracticeFeed({
            db: prisma,
            userId,
            momentId,
            mode: initialMode,
            gameId,
        });
    } catch {
        initialPractice = {
            ownerId: userId,
            prompt: null,
            nextCursor: null,
            appliedFilters: {},
            feedStarted: false,
            feedHadPositions: false,
            loadError: 'The training service is unavailable.',
        };
    }
    const trainerKey = [
        initialPractice.ownerId,
        momentId ?? 'feed',
        initialMode ?? 'RECOMMENDED',
        gameId ?? 'all-games',
    ].join(':');

    return (
        <div className="space-y-3 sm:space-y-6">
            <PageHeader
                title="Practice"
                subtitle="Play the best move you can find, then review the position."
                subtitleClassName="hidden sm:block"
            />
            <TrainingTrainer
                key={trainerKey}
                initialPractice={initialPractice}
                initialMomentId={momentId}
                ownerId={userId}
                entry={entry}
                initialMode={initialMode}
                initialGameId={gameId}
                initialViewMode={initialViewMode}
            />
        </div>
    );
}
